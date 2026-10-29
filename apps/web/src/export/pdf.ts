import type { ExportInput } from "@flaw/exporters/src/model.ts";

export type PdfOptions = { mirrorMargins: boolean; chaptersOnRecto: boolean };
export type PdfResult = { ok: true; bytes: Uint8Array; name: string } | { ok: false };

/** PDF : branché par T-034 (Typst sur l'appareil) et T-035 (repli serveur). */
export function exportPdf(input: ExportInput, id: string, options: PdfOptions): Promise<PdfResult> {
  void input;
  void id;
  void options;
  return Promise.resolve({ ok: false });
}
