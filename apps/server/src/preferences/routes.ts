/**
 * Préférences du compte (API-006, API-007) : dernier écrit gagne, contrôle par ETag.
 * Rien de sensible : thème, objectif, affichage des compteurs, F20, langue, correcteur.
 */
import { createHash } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";

import { sendProblem } from "../platform/problem.ts";

export const DEFAULT_PREFERENCES = {
  theme: "system",
  dailyWordGoal: 500,
  showWordCount: true,
  showDailyGoal: true,
  frenchTypographyDefault: true,
  defaultTextLang: "fr",
  spellcheck: false,
  lastDocumentId: null,
} as const;

const patchSchema = z
  .object({
    theme: z.enum(["light", "dark", "system"]).optional(),
    dailyWordGoal: z.number().int().min(0).max(100_000).optional(),
    showWordCount: z.boolean().optional(),
    showDailyGoal: z.boolean().optional(),
    frenchTypographyDefault: z.boolean().optional(),
    defaultTextLang: z.string().regex(/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/u).optional(),
    spellcheck: z.boolean().optional(),
    lastDocumentId: z.string().uuid().nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);

type Row = { settings: Record<string, unknown>; browser_spellcheck: boolean; updated_at: Date };

export type PreferenceDeps = {
  pool: () => Pool | undefined;
  userId: (request: FastifyRequest) => string | undefined;
};

function view(row: Row | undefined): Record<string, unknown> {
  const settings = row?.settings ?? {};
  return {
    ...DEFAULT_PREFERENCES,
    ...settings,
    spellcheck: row?.browser_spellcheck ?? false,
    updatedAt: (row?.updated_at ?? new Date(0)).toISOString(),
  };
}

function etagOf(body: Record<string, unknown>): string {
  return `"${createHash("sha256").update(JSON.stringify(body)).digest("base64url").slice(0, 27)}"`;
}

async function load(pool: Pool, userId: string): Promise<Row | undefined> {
  const result = await pool.query<Row>(
    "SELECT settings, browser_spellcheck, updated_at FROM flaw.user_preferences WHERE owner_id = $1",
    [userId],
  );
  return result.rows[0];
}

function ready(deps: PreferenceDeps, request: FastifyRequest, reply: FastifyReply): { pool: Pool; userId: string } | undefined {
  const pool = deps.pool();
  const userId = deps.userId(request);
  if (pool === undefined || userId === undefined) {
    sendProblem(reply, 401);
    return undefined;
  }
  return { pool, userId };
}

export function registerPreferences(app: FastifyInstance, deps: PreferenceDeps): void {
  app.get("/api/v1/me/preferences", async (request, reply) => {
    const ok = ready(deps, request, reply);
    if (ok === undefined) {
      return reply;
    }
    const body = view(await load(ok.pool, ok.userId));
    return reply.header("etag", etagOf(body)).header("cache-control", "no-store").send(body);
  });

  app.patch("/api/v1/me/preferences", async (request, reply) => {
    const ok = ready(deps, request, reply);
    if (ok === undefined) {
      return reply;
    }
    const parsed = patchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(422)
        .header("content-type", "application/problem+json; charset=utf-8")
        .send({ type: "about:blank", status: 422, title: "Données invalides", code: "invalid_request" });
    }
    const current = view(await load(ok.pool, ok.userId));
    const ifMatch = request.headers["if-match"];
    if (typeof ifMatch === "string" && ifMatch !== "*" && ifMatch !== etagOf(current)) {
      return reply
        .code(412)
        .header("content-type", "application/problem+json; charset=utf-8")
        .send({ type: "about:blank", status: 412, title: "Préférences modifiées ailleurs", code: "precondition_failed" });
    }
    const { spellcheck, ...rest } = parsed.data;
    const result = await ok.pool.query<Row>(
      `INSERT INTO flaw.user_preferences (owner_id, browser_spellcheck, settings, updated_at)
       VALUES ($1, COALESCE($2, false), $3::jsonb, now())
       ON CONFLICT (owner_id) DO UPDATE
         SET browser_spellcheck = COALESCE($2, flaw.user_preferences.browser_spellcheck),
             settings = flaw.user_preferences.settings || $3::jsonb,
             updated_at = now()
       RETURNING settings, browser_spellcheck, updated_at`,
      [ok.userId, spellcheck ?? null, JSON.stringify(rest)],
    );
    const body = view(result.rows[0]);
    return reply.header("etag", etagOf(body)).header("cache-control", "no-store").send(body);
  });
}
