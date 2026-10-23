import type { DocumentMode } from "../../../packages/schema/src/index.ts";

/**
 * Formats du tableau § 5.4 et de PageFormat (contrat API).
 * Les millimètres de marge ne sont pas dans le paquet T-016 : voir MARGIN_CM.
 */
export const PAGE_FORMATS = {
  novel_13x20: { widthCm: 13, heightCm: 20 },
  pocket_11x17_8: { widthCm: 11, heightCm: 17.8 },
  trade_15x23: { widthCm: 15, heightCm: 23 },
  a5: { widthCm: 14.8, heightCm: 21 },
  a4: { widthCm: 21, heightCm: 29.7 },
  us_letter: { widthCm: 21.59, heightCm: 27.94 },
} as const;

export type PageFormatId = keyof typeof PAGE_FORMATS;

export const MODE_FORMATS = {
  novel: {
    defaultFormat: "novel_13x20",
    formats: ["novel_13x20", "pocket_11x17_8", "trade_15x23", "a5"],
  },
  screenplay: {
    defaultFormat: "us_letter",
    formats: ["us_letter", "a4"],
  },
  document: {
    defaultFormat: "a4",
    formats: ["a4", "us_letter"],
  },
  blank: {
    defaultFormat: "a4",
    formats: ["a4", "novel_13x20", "pocket_11x17_8", "trade_15x23", "a5", "us_letter"],
  },
} as const satisfies Record<
  DocumentMode,
  { defaultFormat: PageFormatId; formats: readonly PageFormatId[] }
>;

export type Surface = "phone" | "tablet" | "desktop";

/**
 * Hypothèse de prototype, pas une valeur du cahier.
 * Roman, document, page blanche : 1,5 cm de chaque côté.
 * Script : marges classiques (1,5 po à gauche, 1 po ailleurs).
 */
export const MARGIN_CM = {
  prose: { top: 1.5, right: 1.5, bottom: 1.5, left: 1.5 },
  screenplay: { top: 2.54, right: 2.54, bottom: 2.54, left: 3.81 },
} as const;

const CSS_PX_PER_CM = 96 / 2.54;
const PHONE_CONTENT_WIDTH_PX = 328;

export type Geometry = {
  formatId: PageFormatId;
  surface: Surface;
  fluid: boolean;
  markedBreaks: boolean;
  pageWidthPx: number;
  pageHeightPx: number;
  contentWidthPx: number;
  contentHeightPx: number;
  fontSizePt: number;
  lineHeightPx: number;
  wordsPerLine: number;
  wordsPerPage: number;
};

function px(cm: number): number {
  return cm * CSS_PX_PER_CM;
}

export function formatsForMode(mode: DocumentMode): readonly PageFormatId[] {
  return MODE_FORMATS[mode].formats;
}

export function defaultFormat(mode: DocumentMode): PageFormatId {
  return MODE_FORMATS[mode].defaultFormat;
}

export function pageGeometry(
  formatId: PageFormatId,
  surface: Surface,
  options?: { fontSizePt?: number; mono?: boolean },
): Geometry {
  const format = PAGE_FORMATS[formatId];
  const fontSizePt = options?.fontSizePt ?? 11;
  const mono = options?.mono ?? false;
  const margins = mono ? MARGIN_CM.screenplay : MARGIN_CM.prose;
  const pageWidthPx = px(format.widthCm);
  const pageHeightPx = px(format.heightCm);
  const contentWidthPx =
    surface === "phone" ? PHONE_CONTENT_WIDTH_PX : pageWidthPx - px(margins.left + margins.right);
  const contentHeightPx = pageHeightPx - px(margins.top + margins.bottom);
  const fontPx = (fontSizePt * 96) / 72;
  const lineHeightPx = fontPx * 1.45;
  const charWidthPx = fontPx * (mono ? 0.6 : 0.5);
  const wordsPerLine = Math.max(1, contentWidthPx / (charWidthPx * 6.1));
  const linesPerPage = Math.max(1, contentHeightPx / lineHeightPx);
  return {
    formatId,
    surface,
    fluid: surface === "phone",
    markedBreaks: true,
    pageWidthPx,
    pageHeightPx,
    contentWidthPx,
    contentHeightPx,
    fontSizePt,
    lineHeightPx,
    wordsPerLine,
    wordsPerPage: Math.max(1, wordsPerLine * linesPerPage),
  };
}
