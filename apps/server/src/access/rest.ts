/**
 * REST des textes. Aucune requête SQL ici : liste, lecture, écriture,
 * suppression et sync appellent la couche d'accès, qui appelle can().
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";

import { sendProblem } from "../platform/problem.ts";
import type { AccessActor } from "./can.ts";
import { deleteOwnedDocument, exportDocument, listOwnedDocuments, patchDocument, readDocument, updateDocument } from "./documents.ts";
import { documentFontSchema, syncBodySchema } from "./schema.ts";
import { syncDocument } from "./sync.ts";

export type ContentRouteDeps = {
  pool: () => Pool | undefined;
  actor: (request: FastifyRequest) => Promise<AccessActor | undefined>;
};

function pathId(params: unknown): string {
  if (params !== null && typeof params === "object" && "id" in params && typeof params.id === "string") {
    return params.id;
  }
  return "";
}

async function open(
  deps: ContentRouteDeps,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<{ pool: Pool; actor: AccessActor } | undefined> {
  const actor = await deps.actor(request);
  const pool = deps.pool();
  if (actor === undefined || pool === undefined) {
    sendProblem(reply, 401);
    return undefined;
  }
  return { pool, actor };
}

export function registerContentRoutes(app: FastifyInstance, deps: ContentRouteDeps): void {
  app.get("/api/v1/documents", async (request, reply) => {
    const ready = await open(deps, request, reply);
    if (ready === undefined) {
      return;
    }
    const documents = await listOwnedDocuments(ready.pool, ready.actor);
    return { documents: documents.map((id) => ({ id })) };
  });

  app.get("/api/v1/documents/:id", async (request, reply) => {
    const ready = await open(deps, request, reply);
    if (ready === undefined) {
      return;
    }
    const result = await readDocument(ready.pool, ready.actor, pathId(request.params));
    if (!result.ok) {
      return sendProblem(reply, 404);
    }
    return { id: result.id };
  });

  app.put("/api/v1/documents/:id", async (request, reply) => {
    const ready = await open(deps, request, reply);
    if (ready === undefined) {
      return;
    }
    const body = documentFontSchema.safeParse(request.body);
    if (!body.success) {
      return sendProblem(reply, 400);
    }
    const result = await updateDocument(ready.pool, ready.actor, pathId(request.params), body.data.font);
    if (!result.ok) {
      return sendProblem(reply, 404);
    }
    return reply.code(204).send();
  });

  app.patch("/api/v1/documents/:id", async (request, reply) => {
    const ready = await open(deps, request, reply);
    if (ready === undefined) {
      return;
    }
    const body = documentFontSchema.safeParse(request.body);
    if (!body.success) {
      return sendProblem(reply, 400);
    }
    const result = await patchDocument(ready.pool, ready.actor, pathId(request.params), body.data.font);
    if (!result.ok) {
      return sendProblem(reply, 404);
    }
    return reply.code(204).send();
  });

  app.delete("/api/v1/documents/:id", async (request, reply) => {
    const ready = await open(deps, request, reply);
    if (ready === undefined) {
      return;
    }
    const result = await deleteOwnedDocument(ready.pool, ready.actor, pathId(request.params));
    if (!result.ok) {
      return sendProblem(reply, 404);
    }
    return reply.code(204).send();
  });

  app.post("/api/v1/documents/:id/export", async (request, reply) => {
    const ready = await open(deps, request, reply);
    if (ready === undefined) {
      return;
    }
    const body = syncBodySchema.safeParse(request.body);
    if (!body.success) {
      return sendProblem(reply, 400);
    }
    const result = await exportDocument(ready.pool, ready.actor, pathId(request.params));
    if (!result.ok) {
      return sendProblem(reply, 404);
    }
    return reply.code(204).send();
  });

  app.post("/api/v1/documents/:id/sync", async (request, reply) => {
    const ready = await open(deps, request, reply);
    if (ready === undefined) {
      return;
    }
    const body = syncBodySchema.safeParse(request.body);
    if (!body.success) {
      return sendProblem(reply, 400);
    }
    const result = await syncDocument(ready.pool, ready.actor, pathId(request.params));
    if (!result.ok) {
      return sendProblem(reply, 404);
    }
    return reply.code(204).send();
  });
}
