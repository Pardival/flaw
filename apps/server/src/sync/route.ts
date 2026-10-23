/**
 * POST /api/v1/documents/:documentId/sync (API-016).
 * Session complète déjà exigée par la garde. 426 si le client est trop ancien
 * pour le texte, 413 au-delà de la taille max, journal chiffré ensuite.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";

import type { AccessActor } from "../access/can.ts";
import { sendProblem } from "../platform/problem.ts";
import { parseSchemaHeader } from "../../../../packages/sync/src/index.ts";
import { syncDocumentHttp, type SyncFailure } from "./journal.ts";

export type SyncReady = {
  pool: Pool;
  actor: AccessActor;
  kek: Uint8Array | undefined;
};

function documentIdOf(params: unknown): string {
  if (params !== null && typeof params === "object" && "documentId" in params && typeof params.documentId === "string") {
    return params.documentId;
  }
  return "";
}

function headerOne(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function mediaType(value: string | string[] | undefined): string {
  const raw = headerOne(value) ?? "";
  return raw.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function bodyLimitOf(request: FastifyRequest): number {
  const limit = request.server.initialConfig.bodyLimit;
  return typeof limit === "number" ? limit : 10 * 1024 * 1024;
}

function sendStatus(reply: FastifyReply, status: 422 | 426): FastifyReply {
  const item =
    status === 426
      ? { title: "Mise à jour requise", code: "upgrade_required" }
      : { title: "Données invalides", code: "invalid_request" };
  return reply
    .code(status)
    .header("content-type", "application/problem+json; charset=utf-8")
    .header("cache-control", "no-store")
    .send({ type: "about:blank", status, title: item.title, code: item.code });
}

function rawBody(body: unknown, octetStream: boolean): Uint8Array | undefined {
  if (!octetStream) {
    return undefined;
  }
  if (Buffer.isBuffer(body)) {
    return new Uint8Array(body);
  }
  if (body instanceof Uint8Array) {
    return body;
  }
  if (body === undefined || body === null) {
    return new Uint8Array();
  }
  return undefined;
}

export async function handleDocumentSync(ready: SyncReady, request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const octetStream = mediaType(request.headers["content-type"]) === "application/octet-stream";
  const outcome = await syncDocumentHttp(
    ready.pool,
    ready.actor,
    ready.kek,
    documentIdOf(request.params),
    rawBody(request.body, octetStream),
    parseSchemaHeader(headerOne(request.headers["x-flaw-schema-version"])),
    bodyLimitOf(request),
  );
  if (!outcome.ok) {
    return fail(reply, outcome.status);
  }
  return reply.code(200).header("content-type", "application/octet-stream").send(outcome.body);
}

function fail(reply: FastifyReply, status: SyncFailure): unknown {
  if (status === 422 || status === 426) {
    return sendStatus(reply, status);
  }
  if (status === 404 || status === 413 || status === 500) {
    return sendProblem(reply, status);
  }
  return sendProblem(reply, 500);
}
