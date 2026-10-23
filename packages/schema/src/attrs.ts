import { ALIGNS, FONT_SIZE_PT_MAX, FONT_SIZE_PT_MIN, type Align } from "./constants.ts";
import { SchemaError } from "./errors.ts";

export function readAlign(value: string | null): Align | null {
  if (value === null) return null;
  if ((ALIGNS as readonly string[]).includes(value)) return value as Align;
  return null;
}

export function assertAlign(value: unknown): void {
  if (value === null) return;
  if (typeof value !== "string" || readAlign(value) === null) {
    throw new SchemaError("invalid_attr");
  }
}

export function assertLevel(value: unknown): void {
  if (value === 1 || value === 2 || value === 3) return;
  throw new SchemaError("invalid_attr");
}

export function assertFontSize(value: unknown): void {
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= FONT_SIZE_PT_MIN &&
    value <= FONT_SIZE_PT_MAX
  ) {
    return;
  }
  throw new SchemaError("invalid_attr");
}

/** Taille lue au collage. Une valeur hors liste est ignorée, le texte reste. */
export function readFontSize(value: string | null): number | null {
  if (value === null || !/^[0-9]+$/.test(value)) return null;
  const pt = Number(value);
  if (pt < FONT_SIZE_PT_MIN || pt > FONT_SIZE_PT_MAX) return null;
  return pt;
}
