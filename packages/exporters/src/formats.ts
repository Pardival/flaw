import type { ExportMode } from "./model.ts";

export type ExportKind = "pdf" | "docx" | "epub" | "fountain";

/** Formats proposés par mode (AC-047) : PDF et Word partout, EPUB hors script, Fountain en script. */
export function formatsForMode(mode: ExportMode): ExportKind[] {
  return mode === "screenplay" ? ["pdf", "docx", "fountain"] : ["pdf", "docx", "epub"];
}
