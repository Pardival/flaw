import { tokens } from "../theme/tokens.ts";

const FORMAT_SOURCE = {
  novel_13x20: "13x20",
  pocket_11x17_8: "poche",
  trade_15x23: "15x23",
  a5: "a5",
  a4: "a4",
  us_letter: "us-letter",
} as const;

export type PageFormat = keyof typeof FORMAT_SOURCE;

type SizedFormat = {
  largeur: { $value: string };
  hauteur: { $value: string };
};

function millimeters(dimension: string): number {
  if (!dimension.endsWith("cm")) {
    throw new Error(`dimension inattendue : ${dimension}`);
  }
  return Math.round(Number(dimension.slice(0, -2)) * 1000) / 100;
}

export function pageSize(format: PageFormat): { widthMm: number; heightMm: number } {
  const source = tokens.formats[FORMAT_SOURCE[format]] as SizedFormat;
  return {
    widthMm: millimeters(source.largeur.$value),
    heightMm: millimeters(source.hauteur.$value),
  };
}

export function pageRatio(format: PageFormat): number {
  const size = pageSize(format);
  return size.widthMm / size.heightMm;
}

export function pageFormats(): Record<PageFormat, { widthMm: number; heightMm: number }> {
  return {
    novel_13x20: pageSize("novel_13x20"),
    pocket_11x17_8: pageSize("pocket_11x17_8"),
    trade_15x23: pageSize("trade_15x23"),
    a5: pageSize("a5"),
    a4: pageSize("a4"),
    us_letter: pageSize("us_letter"),
  };
}
