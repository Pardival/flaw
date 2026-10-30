import type { ExportInput } from "@flaw/exporters/src/model.ts";

import { CSRF_HEADER, CSRF_VALUE } from "../auth-ui/api.ts";
import { LOCAL_ONLY } from "../platform/target.ts";
import type { PdfRequest, PdfResponse } from "./pdf.worker.ts";

export type PdfOptions = { mirrorMargins: boolean; chaptersOnRecto: boolean };
export type PdfResult = { ok: true; bytes: Uint8Array; name: string } | { ok: false };

/** Bascule serveur pour un long texte sur un appareil faible (A-016). */
const HEAVY_WORDS = 50_000;
const DEVICE_TIMEOUT_MS = 60_000;

function countWords(input: ExportInput): number {
  return JSON.stringify(input.doc)
    .replace(/"(type|marks|attrs|content|align|level|pt)"/gu, " ")
    .split(/\s+/u).length;
}

function weakDevice(): boolean {
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return (memory !== undefined && memory <= 4) || navigator.hardwareConcurrency <= 4;
}

function onDevice(request: PdfRequest): Promise<PdfResponse> {
  return new Promise((resolve) => {
    const worker = new Worker(new URL("./pdf.worker.ts", import.meta.url), { type: "module" });
    const timer = window.setTimeout(() => {
      worker.terminate();
      resolve({ ok: false, reason: "compile" });
    }, DEVICE_TIMEOUT_MS);
    worker.onmessage = (event: MessageEvent<PdfResponse>) => {
      window.clearTimeout(timer);
      worker.terminate();
      resolve(event.data);
    };
    worker.onerror = () => {
      window.clearTimeout(timer);
      worker.terminate();
      resolve({ ok: false, reason: "compile" });
    };
    worker.postMessage(request);
  });
}

/** Repli serveur (T-035) : processus enfant isolé, même gabarit. */
async function onServer(id: string, options: PdfOptions): Promise<PdfResult> {
  if (LOCAL_ONLY || !navigator.onLine) {
    return { ok: false };
  }
  const response = await fetch(`/api/v1/documents/${id}/exports`, {
    method: "POST",
    headers: { "content-type": "application/json", [CSRF_HEADER]: CSRF_VALUE },
    // Le serveur part de son propre état du texte (SEC-DATA-02), pas du contenu envoyé.
    body: JSON.stringify({ format: "pdf", options }),
    credentials: "same-origin",
  }).catch(() => null);
  if (!response?.ok) {
    return { ok: false };
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const name = /filename\*=UTF-8''([^;]+)/u.exec(disposition)?.[1];
  return { ok: true, bytes: new Uint8Array(await response.arrayBuffer()), name: name ? decodeURIComponent(name) : "texte.pdf" };
}

/** PDF : sur l'appareil d'abord ; repli serveur si échec, module absent hors ligne, ou long texte sur appareil faible. */
export async function exportPdf(input: ExportInput, id: string, options: PdfOptions): Promise<PdfResult> {
  if (weakDevice() && countWords(input) > HEAVY_WORDS) {
    const server = await onServer(id, options);
    if (server.ok) {
      return server;
    }
  }
  const local = await onDevice({ input, id, options });
  if (local.ok) {
    return { ok: true, bytes: local.bytes, name: local.name };
  }
  return onServer(id, options);
}
