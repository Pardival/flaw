/** Import sur l'appareil (A-017) : .docx, .md, .txt, .pdf → blocs neutres → document du mode. */
import { importDocx } from "./docx/index.ts";
import { fail } from "./errors.ts";
import { LIMITS } from "./limits.ts";
import { importMarkdown } from "./markdown/index.ts";
import { sniff } from "./sniff.ts";
import { importText } from "./text/index.ts";
import type { ImportResult } from "./blocks.ts";

export { toDocument, type Block, type ImportMode, type ImportReport, type ImportResult } from "./blocks.ts";
export { IMPORT_ERRORS, ImportError, type ImportErrorCode } from "./errors.ts";
export { LIMITS } from "./limits.ts";

export function importFile(bytes: Uint8Array, fileName: string): ImportResult {
  const lower = fileName.toLowerCase();
  const kind = sniff(bytes);
  if (kind === "zip") {
    if (lower.endsWith(".docx")) return importDocx(bytes, fileName);
    if (lower.endsWith(".docm") || lower.endsWith(".dotm")) fail("macro");
    if (lower.endsWith(".dotx")) fail("template");
    // Archive ZIP générique (export Notion…) : à décompresser d'abord (AC-078).
    return fail("zip_archive");
  }
  if (kind === "pdf") {
    // Le PDF passe par importFileAsync (pdf.js est asynchrone).
    return fail("unsupported");
  }
  if (lower.endsWith(".docx")) fail("not_zip");
  if (bytes.length > LIMITS.textFileBytes) fail("too_large");
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return importMarkdown(bytes, fileName);
  if (lower.endsWith(".txt")) return importText(bytes, fileName);
  return fail("unsupported");
}

/** Comme importFile, PDF compris (lecture asynchrone, pdf.js chargé à la demande). */
export async function importFileAsync(bytes: Uint8Array, fileName: string): Promise<ImportResult> {
  if (sniff(bytes) === "pdf") {
    const { importPdf } = await import("./pdf/index.ts");
    return importPdf(bytes, fileName);
  }
  return importFile(bytes, fileName);
}
