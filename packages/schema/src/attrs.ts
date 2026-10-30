import { ALIGNS, ASSET_ID, FONT_SIZE_PT_MAX, FONT_SIZE_PT_MIN, IMAGE_ALIGNS, IMAGE_WIDTH_MAX, IMAGE_WIDTH_MIN, type Align } from "./constants.ts";
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

export function assertAssetId(value: unknown, nullable: boolean): void {
  if (nullable && value === null) return;
  if (typeof value === "string" && ASSET_ID.test(value)) return;
  throw new SchemaError("invalid_attr");
}

export function assertImageWidth(value: unknown): void {
  if (typeof value === "number" && Number.isInteger(value) && value >= IMAGE_WIDTH_MIN && value <= IMAGE_WIDTH_MAX) return;
  throw new SchemaError("invalid_attr");
}

/** Rapport hauteur / largeur de l'image affichée (après recadrage). */
export function assertImageRatio(value: unknown): void {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0.05 && value <= 20) return;
  throw new SchemaError("invalid_attr");
}

export function assertImageAlign(value: unknown): void {
  if (typeof value === "string" && (IMAGE_ALIGNS as readonly string[]).includes(value)) return;
  throw new SchemaError("invalid_attr");
}

/** Recadrage en fractions de l'image d'origine : [x, y, largeur, hauteur], ou null. */
export function assertCrop(value: unknown): void {
  if (value === null) return;
  if (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((part) => typeof part === "number" && Number.isFinite(part) && part >= 0 && part <= 1) &&
    (value[2] as number) > 0 &&
    (value[3] as number) > 0 &&
    (value[0] as number) + (value[2] as number) <= 1.000001 &&
    (value[1] as number) + (value[3] as number) <= 1.000001
  ) {
    return;
  }
  throw new SchemaError("invalid_attr");
}

export function assertAlt(value: unknown): void {
  if (typeof value === "string" && value.length <= 500) return;
  throw new SchemaError("invalid_attr");
}
