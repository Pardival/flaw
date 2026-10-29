/**
 * Export complet du compte (SEC-BKP-09, AC-099) : archive ZIP avec chaque texte en
 * JSON ProseMirror et en Markdown (Fountain pour les scripts), les métadonnées, les
 * préférences et la progression quotidienne. Ré-authentification récente exigée ;
 * journalisé dans audit_events (sans contenu).
 */
import { randomUUID } from "node:crypto";

import { strToU8, zipSync, type Zippable } from "fflate";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";

import { exportFountain } from "../../../../packages/exporters/src/fountain/index.ts";
import { safeFileName, type ExportInput } from "../../../../packages/exporters/src/model.ts";
import type { AccessActor } from "../access/can.ts";
import { getDocument, listDocuments, readContent } from "../documents/store.ts";
import { sendProblem } from "../platform/problem.ts";

export type AccountExportDeps = {
  pool: () => Pool | undefined;
  kek: () => Uint8Array | undefined;
  actor: (request: FastifyRequest) => Promise<AccessActor | undefined>;
  sessionId: (request: FastifyRequest) => string | undefined;
};

const REAUTH_WINDOW_MS = 5 * 60 * 1000;

async function allDocuments(pool: Pool, actor: AccessActor, kek: Uint8Array | undefined): Promise<string[]> {
  const ids: string[] = [];
  for (const trashed of [false, true]) {
    let cursor: { at: Date; id: string } | undefined;
    for (let page = 0; page < 1000; page += 1) {
      const listed = await listDocuments(pool, actor, kek, { limit: 200, cursor, trashed, updatedSince: undefined });
      if ("status" in listed) {
        break;
      }
      ids.push(...listed.items.map((item) => item.id));
      if (listed.nextCursor === null || listed.items.length === 0) {
        break;
      }
      const last = listed.items[listed.items.length - 1];
      if (last === undefined) {
        break;
      }
      cursor = { at: new Date(last.updatedAt), id: last.id };
    }
  }
  return [...new Set(ids)];
}

export function registerAccountExport(app: FastifyInstance, deps: AccountExportDeps): void {
  app.post("/api/v1/me/export", async (request, reply) => {
    const pool = deps.pool();
    const kek = deps.kek();
    const actor = await deps.actor(request);
    const sessionId = deps.sessionId(request);
    if (pool === undefined || actor === undefined || sessionId === undefined) {
      return sendProblem(reply, 401);
    }
    const session = await pool.query<{ reauthenticated_at: Date | null }>(
      "SELECT reauthenticated_at FROM flaw.sessions WHERE id = $1 AND owner_id = $2",
      [sessionId, actor.userId],
    );
    const at = session.rows[0]?.reauthenticated_at;
    if (!at || Date.now() - at.getTime() >= REAUTH_WINDOW_MS) {
      return reply
        .code(403)
        .header("content-type", "application/problem+json; charset=utf-8")
        .send({ type: "about:blank", status: 403, title: "Ré-authentification nécessaire", code: "reauth_required" });
    }
    const files: Zippable = {};
    const index: unknown[] = [];
    const used = new Set<string>();
    for (const id of await allDocuments(pool, actor, kek)) {
      const found = await getDocument(pool, actor, kek, id);
      const json = await readContent(pool, actor, kek, id, "prosemirror-json");
      const markdown = await readContent(pool, actor, kek, id, "markdown");
      if (!found.ok || !json.ok) {
        continue;
      }
      const document = found.document;
      let base = safeFileName(document.title, "x").slice(0, -2);
      if (used.has(base)) {
        base = `${base} (${id.slice(0, 8)})`;
      }
      used.add(base);
      const folder = `textes/${document.deletedAt === null ? "" : "corbeille/"}${base}`;
      files[`${folder}/${base}.json`] = strToU8(JSON.stringify(json.body, null, 2));
      if (document.mode === "screenplay") {
        const input: ExportInput = {
          title: document.title,
          mode: "screenplay",
          pageFormat: document.pageFormat as ExportInput["pageFormat"],
          lang: "fr",
          doc: json.body as ExportInput["doc"],
        };
        files[`${folder}/${base}.fountain`] = strToU8(exportFountain(input));
      } else if (markdown.ok && typeof markdown.body === "string") {
        files[`${folder}/${base}.md`] = strToU8(markdown.body);
      }
      index.push({ ...document, files: folder });
    }
    const prefs = await pool.query("SELECT settings, browser_spellcheck, updated_at FROM flaw.user_preferences WHERE owner_id = $1", [actor.userId]);
    const progress = await pool.query("SELECT day::text AS day, device_id, progress_count FROM flaw.daily_progress WHERE owner_id = $1 ORDER BY day", [actor.userId]);
    files["textes.json"] = strToU8(JSON.stringify(index, null, 2));
    files["preferences.json"] = strToU8(JSON.stringify(prefs.rows[0] ?? {}, null, 2));
    files["progression.json"] = strToU8(JSON.stringify(progress.rows, null, 2));
    files["LISEZ-MOI.txt"] = strToU8(
      `Export complet de votre compte Flaw (${new Date().toISOString()}).\n` +
        "Chaque texte : JSON (modèle de document) et Markdown, ou Fountain pour les scripts.\n" +
        "textes.json : métadonnées ; preferences.json ; progression.json : objectif quotidien.\n",
    );
    const archive = zipSync(files, { level: 6 });
    await pool
      .query("INSERT INTO flaw.audit_events (id, owner_id, event_type, result) VALUES ($1, $2, $3, $4)", [
        randomUUID(),
        actor.userId,
        "account_export",
        "ok",
      ])
      .catch(() => undefined);
    return reply
      .header("content-type", "application/zip")
      .header("cache-control", "no-store")
      .header("content-disposition", `attachment; filename="flaw-export-${new Date().toISOString().slice(0, 10)}.zip"`)
      .send(Buffer.from(archive));
  });
}
