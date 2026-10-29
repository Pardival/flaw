/**
 * API REST des textes (API-009 à API-015) et repli de synchronisation.
 * Les routes hors contrat livré répondent après l'authentification, sans les implémenter.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";

import type { AccessActor } from "../access/can.ts";
import { isUuid } from "../access/sql.ts";
import { sendProblem } from "../platform/problem.ts";
import { buildOpenApiDocument } from "../platform/openapi.ts";
import { handleDocumentSync } from "../sync/route.ts";
import {
  createDocument,
  deleteDocument,
  getDocument,
  listDocuments,
  readContent,
  restoreDocument,
  updateDocument,
  purgeExpiredTrash,
  type DocumentView,
  type ListQuery,
} from "./store.ts";
import {
  CONTENT_FORMATS,
  documentCreateSchema,
  documentPatchSchema,
  parseDateTime,
  type ContentFormat,
} from "./schema.ts";

export type ContentRouteDeps = {
  pool: () => Pool | undefined;
  actor: (request: FastifyRequest) => Promise<AccessActor | undefined>;
  kek: () => Uint8Array | undefined;
};

const RESERVED = new Set([
  "GET /api/v1/healthz",
  "GET /api/v1/me",
  "GET /api/v1/me/sessions",
  "DELETE /api/v1/me/sessions",
  "DELETE /api/v1/me/sessions/:sessionId",
  "GET /api/v1/me/preferences",
  "PATCH /api/v1/me/preferences",
  "GET /api/v1/stats/daily",
  "PUT /api/v1/stats/daily/:day/devices/:deviceId",
  "GET /api/v1/documents/:documentId/versions",
  "POST /api/v1/documents/:documentId/versions",
  "POST /api/v1/documents/:documentId/versions/:versionId/restore",
  "POST /api/v1/documents/:documentId/exports",
]);

const HTTP = new Set(["get", "post", "put", "patch", "delete"]);

function problemStatus(status: 404 | 409 | 500): 404 | 500 {
  return status === 404 ? 404 : 500;
}

function sendStatus(reply: FastifyReply, status: 409 | 422 | 426): FastifyReply {
  const titles = {
    409: { title: "Conflit", code: "conflict" },
    422: { title: "Données invalides", code: "invalid_request" },
    426: { title: "Mise à jour requise", code: "upgrade_required" },
  } as const;
  const item = titles[status];
  return reply
    .code(status)
    .header("content-type", "application/problem+json; charset=utf-8")
    .header("cache-control", "no-store")
    .send({ type: "about:blank", status, title: item.title, code: item.code });
}

function queryOf(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function one(value: unknown): string | undefined | "invalid" {
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value) || typeof value !== "string") {
    return "invalid";
  }
  return value;
}

function documentIdOf(params: unknown): string {
  if (params !== null && typeof params === "object" && "documentId" in params && typeof params.documentId === "string") {
    return params.documentId;
  }
  return "";
}

function fullDocument(view: DocumentView): Record<string, unknown> {
  return {
    id: view.id,
    title: view.title,
    mode: view.mode,
    wordCount: view.wordCount,
    updatedAt: view.updatedAt,
    deletedAt: view.deletedAt,
    excerpt: view.excerpt,
    pageFormat: view.pageFormat,
    fontFamily: view.fontFamily,
    baseFontSizePt: view.baseFontSizePt,
    schemaVersion: view.schemaVersion,
    outline: view.outline,
    createdAt: view.createdAt,
  };
}

function parseList(query: unknown): ListQuery | undefined {
  const record = queryOf(query);
  if (record === undefined) {
    return undefined;
  }
  const allowed = new Set(["cursor", "limit", "trashed", "updatedSince"]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      return undefined;
    }
  }
  const limitRaw = one(record.limit);
  let limit = 50;
  if (limitRaw === "invalid") {
    return undefined;
  }
  if (limitRaw !== undefined) {
    if (!/^\d{1,3}$/u.test(limitRaw)) {
      return undefined;
    }
    limit = Number(limitRaw);
    if (limit < 1 || limit > 200) {
      return undefined;
    }
  }
  const trashedRaw = one(record.trashed);
  if (trashedRaw === "invalid" || (trashedRaw !== undefined && trashedRaw !== "true" && trashedRaw !== "false")) {
    return undefined;
  }
  const sinceRaw = one(record.updatedSince);
  if (sinceRaw === "invalid") {
    return undefined;
  }
  const updatedSince = sinceRaw === undefined ? undefined : parseDateTime(sinceRaw);
  if (sinceRaw !== undefined && updatedSince === undefined) {
    return undefined;
  }
  const cursorRaw = one(record.cursor);
  if (cursorRaw === "invalid") {
    return undefined;
  }
  let cursor: ListQuery["cursor"];
  if (cursorRaw !== undefined) {
    cursor = decodeCursor(cursorRaw);
    if (cursor === undefined) {
      return undefined;
    }
  }
  return { limit, cursor, trashed: trashedRaw === "true", updatedSince };
}

function decodeCursor(value: string): { at: Date; id: string } | undefined {
  try {
    const json = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { u?: unknown; i?: unknown };
    if (typeof json.u !== "string" || typeof json.i !== "string" || !isUuid(json.i)) {
      return undefined;
    }
    const at = parseDateTime(json.u);
    if (at === undefined) {
      return undefined;
    }
    return { at, id: json.i.toLowerCase() };
  } catch {
    return undefined;
  }
}

function headerOne(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function open(
  deps: ContentRouteDeps,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<{ pool: Pool; actor: AccessActor; kek: Uint8Array | undefined } | undefined> {
  const actor = await deps.actor(request);
  const pool = deps.pool();
  if (actor === undefined || pool === undefined) {
    sendProblem(reply, 401);
    return undefined;
  }
  return { pool, actor, kek: deps.kek() };
}

function registerStubs(app: FastifyInstance, taken: Set<string>): void {
  const document = buildOpenApiDocument();
  const paths = document.paths as Record<string, unknown>;
  for (const [path, item] of Object.entries(paths)) {
    if (item === null || typeof item !== "object") {
      continue;
    }
    const url = path.replace(/\{([^}]+)\}/gu, ":$1");
    for (const method of Object.keys(item)) {
      if (!HTTP.has(method)) {
        continue;
      }
      const key = `${method.toUpperCase()} ${url}`;
      if (taken.has(key)) {
        continue;
      }
      taken.add(key);
      app.route({
        method: method.toUpperCase() as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
        url,
        handler: async (_request, reply) => sendProblem(reply, 404),
      });
    }
  }
}

export function registerContentRoutes(app: FastifyInstance, deps: ContentRouteDeps): void {
  const taken = new Set(RESERVED);

  const mark = (method: string, url: string): void => {
    taken.add(`${method} ${url}`);
  };

  mark("GET", "/api/v1/documents");
  app.get("/api/v1/documents", async (request, reply) => {
    const ready = await open(deps, request, reply);
    if (ready === undefined) {
      return;
    }
    const query = parseList(request.query);
    if (query === undefined) {
      return sendStatus(reply, 422);
    }
    await purgeExpiredTrash(ready.pool, ready.actor).catch(() => undefined);
    const listed = await listDocuments(ready.pool, ready.actor, ready.kek, query);
    if ("status" in listed) {
      return sendProblem(reply, problemStatus(listed.status));
    }
    return { items: listed.items, nextCursor: listed.nextCursor };
  });

  mark("POST", "/api/v1/documents");
  app.post("/api/v1/documents", async (request, reply) => {
    const ready = await open(deps, request, reply);
    if (ready === undefined) {
      return;
    }
    const idempotency = headerOne(request.headers["idempotency-key"]);
    if (idempotency !== undefined && idempotency.length > 128) {
      return sendStatus(reply, 422);
    }
    const body = documentCreateSchema.safeParse(request.body);
    if (!body.success) {
      return sendStatus(reply, 422);
    }
    const created = await createDocument(ready.pool, ready.actor, ready.kek, body.data);
    if (!created.ok) {
      if (created.status === 409) {
        return sendStatus(reply, 409);
      }
      return sendProblem(reply, problemStatus(created.status));
    }
    return reply.code(created.status).send(fullDocument(created.document));
  });

  mark("GET", "/api/v1/documents/:documentId");
  app.get("/api/v1/documents/:documentId", async (request, reply) => {
    const ready = await open(deps, request, reply);
    if (ready === undefined) {
      return;
    }
    const found = await getDocument(ready.pool, ready.actor, ready.kek, documentIdOf(request.params));
    if (!found.ok) {
      return sendProblem(reply, problemStatus(found.status));
    }
    return reply.header("etag", `"${found.revision}"`).send(fullDocument(found.document));
  });

  mark("PATCH", "/api/v1/documents/:documentId");
  app.patch("/api/v1/documents/:documentId", async (request, reply) => {
    const ready = await open(deps, request, reply);
    if (ready === undefined) {
      return;
    }
    const id = documentIdOf(request.params);
    const found = await getDocument(ready.pool, ready.actor, ready.kek, id);
    if (!found.ok) {
      return sendProblem(reply, problemStatus(found.status));
    }
    const body = documentPatchSchema.safeParse(request.body);
    if (!body.success) {
      return sendStatus(reply, 422);
    }
    const updated = await updateDocument(ready.pool, ready.actor, ready.kek, id, body.data);
    if (!updated.ok) {
      return sendProblem(reply, problemStatus(updated.status));
    }
    return fullDocument(updated.document);
  });

  mark("DELETE", "/api/v1/documents/:documentId");
  app.delete("/api/v1/documents/:documentId", async (request, reply) => {
    const ready = await open(deps, request, reply);
    if (ready === undefined) {
      return;
    }
    const id = documentIdOf(request.params);
    const found = await getDocument(ready.pool, ready.actor, ready.kek, id);
    if (!found.ok) {
      return sendProblem(reply, problemStatus(found.status));
    }
    const record = queryOf(request.query);
    if (record === undefined) {
      return sendStatus(reply, 422);
    }
    for (const key of Object.keys(record)) {
      if (key !== "permanent") {
        return sendStatus(reply, 422);
      }
    }
    const permanentRaw = one(record.permanent);
    if (permanentRaw === "invalid" || (permanentRaw !== undefined && permanentRaw !== "true" && permanentRaw !== "false")) {
      return sendStatus(reply, 422);
    }
    const removed = await deleteDocument(ready.pool, ready.actor, ready.kek, id, permanentRaw === "true");
    if (!removed.ok) {
      return sendProblem(reply, problemStatus(removed.status));
    }
    return reply.code(204).send();
  });

  mark("POST", "/api/v1/documents/:documentId/restore");
  app.post("/api/v1/documents/:documentId/restore", async (request, reply) => {
    const ready = await open(deps, request, reply);
    if (ready === undefined) {
      return;
    }
    const restored = await restoreDocument(ready.pool, ready.actor, ready.kek, documentIdOf(request.params));
    if (!restored.ok) {
      return sendProblem(reply, problemStatus(restored.status));
    }
    return fullDocument(restored.document);
  });

  mark("GET", "/api/v1/documents/:documentId/content");
  app.get("/api/v1/documents/:documentId/content", async (request, reply) => {
    const ready = await open(deps, request, reply);
    if (ready === undefined) {
      return;
    }
    const id = documentIdOf(request.params);
    const found = await getDocument(ready.pool, ready.actor, ready.kek, id);
    if (!found.ok) {
      return sendProblem(reply, problemStatus(found.status));
    }
    const record = queryOf(request.query);
    if (record === undefined) {
      return sendStatus(reply, 422);
    }
    for (const key of Object.keys(record)) {
      if (key !== "format") {
        return sendStatus(reply, 422);
      }
    }
    const formatRaw = one(record.format);
    const format: ContentFormat = formatRaw === undefined ? "prosemirror-json" : (formatRaw as ContentFormat);
    if (formatRaw === "invalid" || (formatRaw !== undefined && !CONTENT_FORMATS.includes(format))) {
      return sendStatus(reply, 422);
    }
    const content = await readContent(ready.pool, ready.actor, ready.kek, id, format);
    if (!content.ok) {
      return sendProblem(reply, problemStatus(content.status));
    }
    if (format === "text") {
      return reply.type("text/plain; charset=utf-8").send(content.body);
    }
    if (format === "markdown") {
      return reply.type("text/markdown; charset=utf-8").send(content.body);
    }
    return content.body;
  });

  mark("POST", "/api/v1/documents/:documentId/sync");
  app.post("/api/v1/documents/:documentId/sync", async (request, reply) => {
    const ready = await open(deps, request, reply);
    if (ready === undefined) {
      return;
    }
    return handleDocumentSync(ready, request, reply);
  });

  try {
    app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_request, body, done) => {
      done(null, body);
    });
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code !== "FST_ERR_CTP_ALREADY_PRESENT") {
      throw error;
    }
  }

  registerStubs(app, taken);
}
