import { paletteOf, type Cover } from "./model.ts";

/**
 * Rendu d'une face de couverture sur un canvas. Le même dessin sert à l'aperçu,
 * à l'export (JPEG 300 ppp) : ce qu'on voit est ce qui s'imprime.
 * Toutes les mesures sont relatives à la largeur de la page.
 */
export type Side = "front" | "back";

function wrap(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\n/u)) {
    const words = paragraph.split(/\s+/u).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let line = words[0] ?? "";
    for (const word of words.slice(1)) {
      const candidate = `${line} ${word}`;
      if (context.measureText(candidate).width <= maxWidth) line = candidate;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** Plus grande taille (px) pour que le texte tienne en `maxLines` lignes. */
function fitSize(context: CanvasRenderingContext2D, text: string, font: (size: number) => string, maxWidth: number, start: number, min: number, maxLines: number): number {
  let size = start;
  while (size > min) {
    context.font = font(size);
    if (wrap(context, text, maxWidth).length <= maxLines) return size;
    size -= Math.max(1, size * 0.06);
  }
  return min;
}

function drawLines(context: CanvasRenderingContext2D, lines: string[], x: number, y: number, lineHeight: number, align: CanvasTextAlign): number {
  context.textAlign = align;
  lines.forEach((line, index) => context.fillText(line, x, y + index * lineHeight));
  return y + lines.length * lineHeight;
}

function drawImageCover(context: CanvasRenderingContext2D, image: CanvasImageSource & { width: number; height: number }, x: number, y: number, w: number, h: number): void {
  const scale = Math.max(w / image.width, h / image.height);
  const sw = w / scale;
  const sh = h / scale;
  context.drawImage(image, (image.width - sw) / 2, (image.height - sh) / 2, sw, sh, x, y, w, h);
}

const serifish = (font: string) => (font === "Inter" ? "sans-serif" : font === "Courier Prime" ? "monospace" : "serif");

export function drawCover(
  context: CanvasRenderingContext2D,
  side: Side,
  cover: Cover,
  width: number,
  height: number,
  image: (CanvasImageSource & { width: number; height: number }) | null,
): void {
  const palette = paletteOf(cover);
  const u = width / 100;
  const family = `"${cover.font}", ${serifish(cover.font)}`;
  const title = cover.title.trim();
  context.save();
  context.textBaseline = "alphabetic";
  context.fillStyle = palette.background;
  context.fillRect(0, 0, width, height);

  if (side === "back") {
    if (cover.template === "photo" && image) {
      drawImageCover(context, image, 0, 0, width, height);
      context.fillStyle = "rgba(0, 0, 0, 0.62)";
      context.fillRect(0, 0, width, height);
    }
    const ink = cover.template === "photo" && image ? "#F7F3EA" : palette.ink;
    context.fillStyle = ink;
    const margin = 13 * u;
    let y = 22 * u;
    if (cover.backShowTitle && title) {
      context.font = `600 ${String(5.2 * u)}px ${family}`;
      y = drawLines(context, wrap(context, title, width - 2 * margin), width / 2, y, 6.4 * u, "center") + 5 * u;
      context.fillStyle = palette.accent;
      context.fillRect(width / 2 - 5 * u, y - 3 * u, 10 * u, 0.4 * u);
      context.fillStyle = ink;
      y += 4 * u;
    }
    const body = cover.backText.trim();
    if (body) {
      const size = fitSize(context, body, (s) => `${String(s)}px ${family}`, width - 2 * margin, 4.4 * u, 2.6 * u, Math.floor((height - y - 22 * u) / (4.4 * u * 1.45)));
      context.font = `${String(size)}px ${family}`;
      drawLines(context, wrap(context, body, width - 2 * margin), margin, y, size * 1.45, "left");
    }
    if (cover.author.trim()) {
      context.font = `${String(3.6 * u)}px ${family}`;
      context.globalAlpha = 0.8;
      drawLines(context, [cover.author.trim()], width / 2, height - 10 * u, 0, "center");
      context.globalAlpha = 1;
    }
    context.restore();
    return;
  }

  const titleFont = (size: number) => `${cover.font === "Inter" ? "700" : "500"} ${String(size)}px ${family}`;
  const subtitleFont = `italic ${String(4.6 * u)}px ${family}`;
  const authorFont = `${String(4.8 * u)}px ${family}`;

  switch (cover.template) {
    case "photo": {
      if (image) drawImageCover(context, image, 0, 0, width, height);
      const gradient = context.createLinearGradient(0, height * 0.45, 0, height);
      gradient.addColorStop(0, "rgba(0,0,0,0)");
      gradient.addColorStop(1, "rgba(0,0,0,0.72)");
      context.fillStyle = gradient;
      context.fillRect(0, 0, width, height);
      context.fillStyle = "#FFFFFF";
      const size = fitSize(context, title, titleFont, width - 16 * u, 13 * u, 6 * u, 3);
      context.font = titleFont(size);
      const lines = wrap(context, title, width - 16 * u);
      let y = height - 18 * u - (lines.length - 1) * size * 1.08 - (cover.subtitle ? 7 * u : 0);
      y = drawLines(context, lines, 8 * u, y, size * 1.08, "left");
      if (cover.subtitle) {
        context.font = subtitleFont;
        drawLines(context, [cover.subtitle], 8 * u, y + 1 * u, 0, "left");
      }
      context.font = authorFont;
      context.globalAlpha = 0.9;
      drawLines(context, [cover.author.toUpperCase()], 8 * u, 12 * u, 0, "left");
      context.globalAlpha = 1;
      break;
    }
    case "band": {
      const bandTop = height * 0.62;
      if (image) drawImageCover(context, image, 0, 0, width, bandTop);
      else {
        context.fillStyle = palette.accent;
        context.fillRect(0, 0, width, bandTop);
      }
      context.fillStyle = palette.background;
      context.fillRect(0, bandTop, width, height - bandTop);
      context.fillStyle = palette.ink;
      const size = fitSize(context, title, titleFont, width - 16 * u, 10 * u, 5 * u, 2);
      context.font = titleFont(size);
      const y = drawLines(context, wrap(context, title, width - 16 * u), width / 2, bandTop + 8 * u + size * 0.8, size * 1.1, "center");
      if (cover.subtitle) {
        context.font = subtitleFont;
        drawLines(context, [cover.subtitle], width / 2, y + 1 * u, 0, "center");
      }
      context.font = authorFont;
      drawLines(context, [cover.author], width / 2, height - 8 * u, 0, "center");
      break;
    }
    case "minimal": {
      context.fillStyle = palette.ink;
      const size = fitSize(context, title, titleFont, width - 18 * u, 15 * u, 6 * u, 4);
      context.font = titleFont(size);
      const y = drawLines(context, wrap(context, title, width - 18 * u), 9 * u, 16 * u + size * 0.8, size * 1.04, "left");
      context.fillStyle = palette.accent;
      context.fillRect(9 * u, y + 1 * u, 14 * u, 0.9 * u);
      context.fillStyle = palette.ink;
      if (cover.subtitle) {
        context.font = subtitleFont;
        drawLines(context, [cover.subtitle], 9 * u, y + 9 * u, 0, "left");
      }
      if (image) {
        const box = 40 * u;
        drawImageCover(context, image, width - 9 * u - box, height - 22 * u - box, box, box);
      }
      context.font = authorFont;
      drawLines(context, [cover.author], 9 * u, height - 9 * u, 0, "left");
      break;
    }
    default: {
      context.fillStyle = palette.ink;
      context.font = authorFont;
      context.globalAlpha = 0.85;
      drawLines(context, [cover.author], width / 2, 14 * u, 0, "center");
      context.globalAlpha = 1;
      const size = fitSize(context, title, titleFont, width - 18 * u, 11 * u, 5 * u, 3);
      context.font = titleFont(size);
      const lines = wrap(context, title, width - 18 * u);
      let y = drawLines(context, lines, width / 2, 30 * u + size * 0.8, size * 1.1, "center");
      context.fillStyle = palette.accent;
      context.fillRect(width / 2 - 6 * u, y + 0.5 * u, 12 * u, 0.5 * u);
      context.fillStyle = palette.ink;
      if (cover.subtitle) {
        context.font = subtitleFont;
        y = drawLines(context, [cover.subtitle], width / 2, y + 8 * u, 0, "center");
      }
      if (image) {
        const top = Math.max(y + 8 * u, height * 0.5);
        const box = Math.min(width - 28 * u, height - top - 12 * u);
        if (box > 10 * u) drawImageCover(context, image, (width - box) / 2, top, box, box);
      }
    }
  }
  context.restore();
}

/** Polices de la couverture chargées avant de dessiner (sinon repli système). */
export async function loadCoverFonts(cover: Cover): Promise<void> {
  const fonts = document.fonts as FontFaceSet | undefined;
  if (!fonts) return;
  await Promise.all(
    [`500 40px "${cover.font}"`, `700 40px "${cover.font}"`, `italic 40px "${cover.font}"`, `40px "${cover.font}"`, `600 40px "${cover.font}"`].map((spec) =>
      fonts.load(spec).catch(() => []),
    ),
  );
}

/** Face rendue en JPEG pour l'export, à 300 ppp (plafonnée à 2 400 px de large). */
export async function renderCoverJpeg(
  side: Side,
  cover: Cover,
  pageMm: { width: number; height: number },
  image: (CanvasImageSource & { width: number; height: number }) | null,
): Promise<Uint8Array> {
  await loadCoverFonts(cover);
  const width = Math.min(2400, Math.round((pageMm.width / 25.4) * 300));
  const height = Math.round((width * pageMm.height) / pageMm.width);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("canvas indisponible");
  drawCover(context, side, cover, width, height, image);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
  if (blob === null) throw new Error("encodage impossible");
  return new Uint8Array(await blob.arrayBuffer());
}
