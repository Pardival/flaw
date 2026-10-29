/**
 * Repli serveur des exports (API, exportDocument) : même gabarit Typst que l'appareil,
 * dans un processus enfant (mémoire ≤ 900 Mo, 60 s, oom_score_adj 1000), un à la fois.
 * Le contenu vient de l'état stocké du texte, validé par le schéma (SEC-DATA-02).
 */
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";

import { safeFileName, type ExportInput } from "../../../../packages/exporters/src/model.ts";
import { pdfData } from "../../../../packages/exporters/src/pdf/template.ts";
import type { AccessActor } from "../access/can.ts";
import { getDocument, readContent } from "../documents/store.ts";
import { sendProblem } from "../platform/problem.ts";

export type ExportDeps = {
  pool: () => Pool | undefined;
  kek: () => Uint8Array | undefined;
  actor: (request: FastifyRequest) => Promise<AccessActor | undefined>;
};

const bodySchema = z
  .object({
    format: z.literal("pdf"),
    options: z.object({ mirrorMargins: z.boolean(), chaptersOnRecto: z.boolean() }).strict().optional(),
  })
  .strict();

const CHILD = fileURLToPath(new URL("./pdf-child.ts", import.meta.url));
const TIMEOUT_MS = 60_000;
const MAX_BYTES = 200 * 1024 * 1024;
let busy = false;

function renderPdf(data: Uint8Array): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--max-old-space-size=900", CHILD], { stdio: ["pipe", "pipe", "ignore"] });
    // Le noyau tue ce processus en premier en cas de manque de mémoire (Linux).
    if (child.pid !== undefined) {
      void writeFile(`/proc/${String(child.pid)}/oom_score_adj`, "1000").catch(() => undefined);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BYTES) {
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 && size > 0 && size <= MAX_BYTES ? Buffer.concat(chunks) : undefined);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.stdin.end(Buffer.from(data));
  });
}

export function registerExports(app: FastifyInstance, deps: ExportDeps): void {
  app.post("/api/v1/documents/:documentId/exports", async (request, reply) => {
    const pool = deps.pool();
    const kek = deps.kek();
    const actor = await deps.actor(request);
    if (pool === undefined || actor === undefined) {
      return sendProblem(reply, 401);
    }
    const body = bodySchema.safeParse(request.body);
    const id = (request.params as { documentId?: string }).documentId ?? "";
    if (!body.success) {
      return reply
        .code(422)
        .header("content-type", "application/problem+json; charset=utf-8")
        .send({ type: "about:blank", status: 422, title: "Données invalides", code: "invalid_request" });
    }
    const found = await getDocument(pool, actor, kek, id);
    const content = await readContent(pool, actor, kek, id, "prosemirror-json");
    if (!found.ok || !content.ok) {
      return sendProblem(reply, 404);
    }
    if (busy) {
      return reply
        .code(429)
        .header("retry-after", "30")
        .header("content-type", "application/problem+json; charset=utf-8")
        .send({ type: "about:blank", status: 429, title: "Un export est déjà en cours", code: "busy" });
    }
    busy = true;
    try {
      const document = found.document;
      const input: ExportInput = {
        title: document.title,
        mode: document.mode as ExportInput["mode"],
        pageFormat: document.pageFormat as ExportInput["pageFormat"],
        lang: "fr",
        fontFamily: document.fontFamily,
        baseFontSizePt: document.baseFontSizePt,
        doc: content.body as ExportInput["doc"],
      };
      const options = body.data.options ?? { mirrorMargins: input.mode === "novel", chaptersOnRecto: input.mode === "novel" };
      const pdf = await renderPdf(pdfData(input, options));
      if (pdf === undefined) {
        return sendProblem(reply, 500);
      }
      const name = safeFileName(input.title, "pdf");
      return reply
        .header("content-type", "application/pdf")
        .header("cache-control", "no-store")
        .header("content-disposition", `attachment; filename="export.pdf"; filename*=UTF-8''${encodeURIComponent(name)}`)
        .send(pdf);
    } finally {
      busy = false;
    }
  });
}
