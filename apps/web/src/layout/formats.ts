import { tokens } from "../theme/tokens.ts";

export type PageFormat = keyof typeof tokens.page.formats;

export function pageRatio(format: PageFormat): number {
  const size = tokens.page.formats[format];
  return size.widthMm / size.heightMm;
}
