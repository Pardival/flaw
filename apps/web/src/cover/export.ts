import { PAGE_MM, type ExportAsset, type ExportFormat } from "@flaw/exporters/src/model.ts";
import type * as Y from "yjs";

import { getAsset } from "../editor/images/assets.ts";
import { readCover } from "./model.ts";
import { renderCoverJpeg } from "./render.ts";

/** 1re et 4e rendues pour l'export, ou rien si le texte n'a pas de couverture. */
export async function coverExport(doc: Y.Doc, format: ExportFormat, include: boolean): Promise<{ front?: ExportAsset; back?: ExportAsset } | undefined> {
  const cover = readCover(doc);
  if (!include || cover === null) return undefined;
  const bytes = cover.image ? getAsset(doc, cover.image.asset) : null;
  const image = bytes === null ? null : await createImageBitmap(new Blob([bytes as BlobPart]));
  try {
    const page = PAGE_MM[format];
    const front = await renderCoverJpeg("front", cover, page, image);
    const hasBack = cover.backText.trim().length > 0 || cover.backShowTitle;
    const back = hasBack ? await renderCoverJpeg("back", cover, page, image) : undefined;
    return { front: { bytes: front, kind: "jpeg" }, ...(back ? { back: { bytes: back, kind: "jpeg" as const } } : {}) };
  } finally {
    image?.close();
  }
}

export function hasCover(doc: Y.Doc | null): boolean {
  return doc !== null && readCover(doc) !== null;
}
