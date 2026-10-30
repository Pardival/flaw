import { LIMITS, type ImportErrorCode, type ImportResult } from "@flaw/importers/src/index.ts";

import type { ImportResponse } from "./import.worker.ts";

export type ImportJob = { promise: Promise<ImportResponse>; cancel: () => void };

const ACCEPTED = /\.(docx|pdf|md|markdown|txt)$/iu;

/** Contrôle avant toute lecture (SEC-IMP-03) : extension et taille du fichier. */
export function precheck(file: File): ImportErrorCode | null {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".zip")) return "zip_archive";
  if (!ACCEPTED.test(lower)) return "unsupported";
  const limit = lower.endsWith(".pdf") ? LIMITS.pdfFileBytes : lower.endsWith(".docx") ? LIMITS.docxFileBytes : LIMITS.textFileBytes;
  return file.size > limit ? "too_large" : null;
}

/** Un worker par fichier, tué à 30 s ou sur Annuler ; le fichier ne quitte jamais l'appareil. */
export function startImport(file: File): ImportJob {
  const worker = new Worker(new URL("./import.worker.ts", import.meta.url), { type: "module" });
  let settle: (value: ImportResponse) => void = () => undefined;
  const promise = new Promise<ImportResponse>((resolve) => {
    settle = resolve;
  });
  const timer = window.setTimeout(() => {
    worker.terminate();
    settle({ ok: false, code: "timeout" });
  }, LIMITS.timeoutMs);
  worker.onmessage = (event: MessageEvent<ImportResponse>) => {
    window.clearTimeout(timer);
    worker.terminate();
    settle(event.data);
  };
  worker.onerror = () => {
    window.clearTimeout(timer);
    worker.terminate();
    settle({ ok: false, code: "xml" });
  };
  void file.arrayBuffer().then(
    (buffer) => {
      const bytes = new Uint8Array(buffer);
      worker.postMessage({ bytes, name: file.name }, [bytes.buffer]);
    },
    () => {
      window.clearTimeout(timer);
      worker.terminate();
      settle({ ok: false, code: "unsupported" });
    },
  );
  return {
    promise,
    cancel: () => {
      window.clearTimeout(timer);
      worker.terminate();
      settle({ ok: false, code: "timeout" });
    },
  };
}

export type { ImportResult };
