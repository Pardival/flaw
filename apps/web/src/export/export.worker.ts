/// <reference lib="webworker" />
import { exportDocx, exportEpub, exportFountain, safeFileName, type ExportInput } from "@flaw/exporters/src/index.ts";

/** Exports dans un Web Worker (A-016) : la frappe n'est jamais bloquée. */
export type ExportRequest = { kind: "docx" | "epub" | "fountain"; input: ExportInput; id: string };
export type ExportResponse = { ok: true; bytes: Uint8Array; name: string; mime: string } | { ok: false };

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = async (event: MessageEvent<ExportRequest>) => {
  const { kind, input, id } = event.data;
  try {
    let response: ExportResponse;
    if (kind === "docx") {
      response = {
        ok: true,
        bytes: await exportDocx(input),
        name: safeFileName(input.title, "docx"),
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      };
    } else if (kind === "epub") {
      response = { ok: true, bytes: exportEpub(input, id), name: safeFileName(input.title, "epub"), mime: "application/epub+zip" };
    } else {
      response = {
        ok: true,
        bytes: new TextEncoder().encode(exportFountain(input)),
        name: safeFileName(input.title, "fountain"),
        mime: "text/plain; charset=utf-8",
      };
    }
    scope.postMessage(response, response.ok ? [response.bytes.buffer] : []);
  } catch {
    scope.postMessage({ ok: false } satisfies ExportResponse);
  }
};
