import type { DocumentMode, PageFormat } from "../local-store/index.ts";
import { pageSize } from "../layout/formats.ts";

/** Formats proposés par mode, défaut en tête (cahier § 5.4, AC-002). */
export const FORMATS_BY_MODE: Record<DocumentMode, readonly PageFormat[]> = {
  novel: ["novel_13x20", "pocket_11x17_8", "trade_15x23", "a5"],
  screenplay: ["us_letter", "a4"],
  document: ["a4", "us_letter"],
  blank: ["a4", "novel_13x20", "pocket_11x17_8", "trade_15x23", "a5", "us_letter"],
};

export function defaultFormat(mode: DocumentMode): PageFormat {
  return FORMATS_BY_MODE[mode][0] as PageFormat;
}

/** Marges par format (jetons `--marges-*`), en cm, ordre CSS : haut, droite, bas, gauche. */
const MARGINS_CM: Record<PageFormat, [number, number, number, number]> = {
  novel_13x20: [2, 2.4, 2, 1.6],
  pocket_11x17_8: [1.6, 2, 1.7, 1.3],
  trade_15x23: [2.2, 2.6, 2.2, 1.8],
  a5: [2, 2.4, 2, 1.7],
  a4: [2.5, 2.5, 2.5, 2.5],
  us_letter: [2.54, 2.54, 2.54, 2.54],
};

export function formatMarginsCm(format: PageFormat, mode: DocumentMode): [number, number, number, number] {
  // Script : 1 in partout, 1,5 in à gauche (--marges-script).
  return mode === "screenplay" ? [2.54, 2.54, 2.54, 3.81] : MARGINS_CM[format];
}

/** Cotes lisibles en cm, virgule décimale française. */
export function formatCm(mm: number): string {
  return (Math.round(mm) / 10).toLocaleString("fr-FR", { maximumFractionDigits: 2 });
}

export function formatDimensions(format: PageFormat): string {
  const { widthMm, heightMm } = pageSize(format);
  return `${formatCm(widthMm)} × ${formatCm(heightMm)} cm`;
}

/** Variable CSS de la police du mode, pour les titres de la liste (D-009). */
export const MODE_FONT: Record<DocumentMode, string> = {
  novel: "var(--police-roman)",
  screenplay: "var(--police-script)",
  document: "var(--police-document)",
  blank: "var(--police-page-blanche)",
};
