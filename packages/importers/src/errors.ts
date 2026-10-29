/** Codes d'erreur stables de l'import (C8), un par motif, partagés avec le corpus CI (T-041). */
export const IMPORT_ERRORS = [
  "bomb",
  "zip",
  "zip_size",
  "entries",
  "path",
  "dup",
  "overlap",
  "not_zip",
  "ole",
  "macro",
  "template",
  "strict",
  "main_part",
  "dtd",
  "xml",
  "xml_encoding",
  "depth",
  "attrs",
  "nesting",
  "too_large",
  "output_too_large",
  "encoding",
  "null_bytes",
  "unsupported",
  "zip_archive",
  "timeout",
] as const;

export type ImportErrorCode = (typeof IMPORT_ERRORS)[number];

export class ImportError extends Error {
  readonly code: ImportErrorCode;
  constructor(code: ImportErrorCode) {
    super(code);
    this.name = "ImportError";
    this.code = code;
  }
}

export function fail(code: ImportErrorCode): never {
  throw new ImportError(code);
}
