import type { ExportInput } from "@flaw/exporters/src/model.ts";

import { saveFile } from "../platform/files.ts";
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
  void saveFile(bytes, name, mime).catch(() => undefined);
}

export type { ExportInput };
