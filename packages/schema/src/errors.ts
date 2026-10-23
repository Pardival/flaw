/** Erreur de schéma : le message est un code stable, jamais du HTML. */
export const SCHEMA_ERROR_CODES = [
  "invalid_json",
  "unknown_node",
  "unknown_mark",
  "unknown_attr",
  "invalid_attr",
  "invalid_content",
] as const;

export type SchemaErrorCode = (typeof SCHEMA_ERROR_CODES)[number];

export class SchemaError extends Error {
  readonly code: SchemaErrorCode;

  constructor(code: SchemaErrorCode) {
    super(code);
    this.name = "SchemaError";
    this.code = code;
  }
}
