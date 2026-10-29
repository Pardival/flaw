import type { DocumentMode, PageFormat } from "../../local-store/index.ts";
import { pageSize } from "../../layout/formats.ts";
import { formatMarginsCm } from "../../library/formats-by-mode.ts";

/**
 * Géométrie de page (T-016, niveau 1). Les tailles sont celles de l'impression ;
 * l'écran applique l'échelle du mode (--echelle-*), sans changer le découpage.
 */
export type Surface = "phone" | "tablet" | "desktop";

export type Geometry = {
  format: PageFormat;
  surface: Surface;
  fluid: boolean;
  pageWidthPx: number;
  pageHeightPx: number;
  marginsPx: { top: number; right: number; bottom: number; left: number };
  contentWidthPx: number;
  contentHeightPx: number;
  fontSizePt: number;
  lineHeightPx: number;
  wordsPerLine: number;
  wordsPerPage: number;
};

const CSS_PX_PER_CM = 96 / 2.54;

/** Corps et interligne par mode (jetons --*-taille, --*-interligne). */
export const MODE_TYPE: Record<DocumentMode, { sizePt: number; lineHeight: number; mono: boolean; scale: number }> = {
  novel: { sizePt: 11.5, lineHeight: 1.42, mono: false, scale: 1.3 },
  screenplay: { sizePt: 12, lineHeight: 1, mono: true, scale: 1.1 },
  document: { sizePt: 10.5, lineHeight: 1.55, mono: false, scale: 1.22 },
  blank: { sizePt: 12, lineHeight: 1.5, mono: false, scale: 1.12 },
};

export function surfaceOf(width: number): Surface {
  if (width < 600) {
    return "phone";
  }
  return width < 1024 ? "tablet" : "desktop";
}

export function pageGeometry(mode: DocumentMode, format: PageFormat, surface: Surface, phoneWidthPx = 358): Geometry {
  const { widthMm, heightMm } = pageSize(format);
  const [top, right, bottom, left] = formatMarginsCm(format, mode).map((cm) => cm * CSS_PX_PER_CM) as [
    number,
    number,
    number,
    number,
  ];
  const type = MODE_TYPE[mode];
  const pageWidthPx = (widthMm / 10) * CSS_PX_PER_CM;
  const pageHeightPx = (heightMm / 10) * CSS_PX_PER_CM;
  // Téléphone : colonne fluide ; le texte est rendu à l'échelle, on ramène sa largeur à l'impression.
  const contentWidthPx = surface === "phone" ? phoneWidthPx / type.scale : pageWidthPx - left - right;
  const contentHeightPx = pageHeightPx - top - bottom;
  const fontPx = (type.sizePt * 96) / 72;
  const lineHeightPx = fontPx * type.lineHeight;
  const charWidthPx = fontPx * (type.mono ? 0.6 : 0.5);
  const wordsPerLine = Math.max(1, contentWidthPx / (charWidthPx * 6.1));
  const linesPerPage = Math.max(1, contentHeightPx / lineHeightPx);
  return {
    format,
    surface,
    fluid: surface === "phone",
    pageWidthPx,
    pageHeightPx,
    marginsPx: { top, right, bottom, left },
    contentWidthPx,
    contentHeightPx,
    fontSizePt: type.sizePt,
    lineHeightPx,
    wordsPerLine,
    wordsPerPage: Math.max(1, wordsPerLine * linesPerPage),
  };
}
