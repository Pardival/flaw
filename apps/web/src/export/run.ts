import type { ExportInput } from "@flaw/exporters/src/model.ts";

import type { ExportRequest, ExportResponse } from "./export.worker.ts";

export function runExport(request: ExportRequest): Promise<ExportResponse> {
  return new Promise((resolve) => {
    const worker = new Worker(new URL("./export.worker.ts", import.meta.url), { type: "module" });
    const timer = window.setTimeout(() => {
      worker.terminate();
      resolve({ ok: false });
    }, 60_000);
    worker.onmessage = (event: MessageEvent<ExportResponse>) => {
      window.clearTimeout(timer);
      worker.terminate();
      resolve(event.data);
    };
    worker.onerror = () => {
      window.clearTimeout(timer);
      worker.terminate();
      resolve({ ok: false });
    };
    worker.postMessage(request);
  });
}

/** Enregistre le fichier sur l'appareil (aucun envoi). */
export function download(bytes: Uint8Array, name: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export type { ExportInput };
