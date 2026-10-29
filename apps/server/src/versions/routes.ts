/** Routes de l'historique (API-017, API-018, API-019) et aperçu d'une version (D-039). */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";

import type { AccessActor } from "../access/can.ts";
import { sendProblem } from "../platform/problem.ts";
import { createManualVersion, listVersions, previewVersion, restoreVersion } from "./store.ts";

export type VersionDeps = {
  pool: () => Pool | undefined;
  kek: () => Uint8Array | undefined;
  actor: (request: FastifyRequest) => Promise<AccessActor | undefined>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const createSchema = z.object({ label: z.string().max(120).optional() }).strict();

function idOf(params: unknown, key: string): string | undefined {
  const value = (params as Record<string, unknown>)[key];
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : undefined;
}

export const VERSION_ROUTES = [
  "GET /api/v1/documents/:documentId/versions",
  "POST /api/v1/documents/:documentId/versions",
  "POST /api/v1/documents/:documentId/versions/:versionId/restore",
  "GET /api/v1/documents/:documentId/versions/:versionId/preview",
] as const;

export function registerVersions(app: FastifyInstance, deps: VersionDeps): void {
  const ready = async (request: FastifyRequest) => {
    const pool = deps.pool();
    const kek = deps.kek();
    const actor = await deps.actor(request);
    return pool === undefined || kek === undefined || actor === undefined ? undefined : { pool, kek, actor };
  };

  app.get("/api/v1/documents/:documentId/versions", async (request, reply) => {
    const ok = await ready(request);
    const documentId = idOf(request.params, "documentId");
    if (ok === undefined) {
      return sendProblem(reply, 401);
    }
    const items = documentId === undefined ? undefined : await listVersions(ok.pool, ok.actor, ok.kek, documentId);
    return items === undefined ? sendProblem(reply, 404) : reply.header("cache-control", "no-store").send({ items });
  });

  app.post("/api/v1/documents/:documentId/versions", async (request, reply) => {
    const ok = await ready(request);
    const documentId = idOf(request.params, "documentId");
    if (ok === undefined) {
      return sendProblem(reply, 401);
    }
    const body = createSchema.safeParse(request.body ?? {});
    if (!body.success || documentId === undefined) {
      return sendProblem(reply, 404);
    }
    const label = body.data.label?.trim() ? body.data.label.trim() : null;
    const created = await createManualVersion(ok.pool, ok.actor, ok.kek, documentId, label);
    return created === undefined ? sendProblem(reply, 404) : reply.code(201).send(created);
  });

  app.post("/api/v1/documents/:documentId/versions/:versionId/restore", async (request, reply) => {
    const ok = await ready(request);
    const documentId = idOf(request.params, "documentId");
    const versionId = idOf(request.params, "versionId");
    if (ok === undefined) {
      return sendProblem(reply, 401);
    }
    if (documentId === undefined || versionId === undefined || !(await restoreVersion(ok.pool, ok.actor, ok.kek, documentId, versionId))) {
      return sendProblem(reply, 404);
    }
    return reply.code(200).send({ id: documentId, restored: versionId });
  });

  app.get("/api/v1/documents/:documentId/versions/:versionId/preview", async (request, reply) => {
    const ok = await ready(request);
    const documentId = idOf(request.params, "documentId");
    const versionId = idOf(request.params, "versionId");
    if (ok === undefined) {
      return sendProblem(reply, 401);
    }
    const text = documentId === undefined || versionId === undefined ? undefined : await previewVersion(ok.pool, ok.actor, ok.kek, documentId, versionId);
    return text === undefined
      ? sendProblem(reply, 404)
      : reply.header("cache-control", "no-store").header("content-type", "text/plain; charset=utf-8").send(text);
  });
}
