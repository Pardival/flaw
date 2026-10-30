/**
 * Préparation d'une image sur l'appareil : décodée, réduite (2 000 px au plus sur
 * le grand côté), puis réencodée en JPEG, ou en PNG si elle a de la transparence.
 * Les métadonnées (EXIF, position GPS…) disparaissent au passage.
 */
export const MAX_IMAGE_SIDE = 2000;
export const MAX_SOURCE_BYTES = 40 * 1024 * 1024;

export type Prepared = { bytes: Uint8Array; width: number; height: number };

export type Crop = [number, number, number, number];

function hasAlpha(context: CanvasRenderingContext2D, width: number, height: number): boolean {
  const data = context.getImageData(0, 0, width, height).data;
  for (let index = 3; index < data.length; index += 4 * 16) {
    if ((data[index] ?? 255) < 250) return true;
  }
  return false;
}

async function encode(canvas: HTMLCanvasElement, transparent: boolean): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, transparent ? "image/png" : "image/jpeg", 0.88);
  });
  if (blob === null) throw new Error("encodage impossible");
  return new Uint8Array(await blob.arrayBuffer());
}

/** Décode, recadre (fractions de l'image) et réduit. */
export async function prepareImage(source: Blob, crop: Crop | null = null, maxSide = MAX_IMAGE_SIDE): Promise<Prepared> {
  if (source.size > MAX_SOURCE_BYTES) throw new Error("image trop lourde");
  const bitmap = await createImageBitmap(source, { imageOrientation: "from-image" });
  try {
    const [cx, cy, cw, ch] = crop ?? [0, 0, 1, 1];
    const sx = Math.round(cx * bitmap.width);
    const sy = Math.round(cy * bitmap.height);
    const sw = Math.max(1, Math.round(cw * bitmap.width));
    const sh = Math.max(1, Math.round(ch * bitmap.height));
    const scale = Math.min(1, maxSide / Math.max(sw, sh));
    const width = Math.max(1, Math.round(sw * scale));
    const height = Math.max(1, Math.round(sh * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (context === null) throw new Error("canvas indisponible");
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, sx, sy, sw, sh, 0, 0, width, height);
    const transparent = source.type === "image/png" && hasAlpha(context, width, height);
    if (!transparent) {
      // Fond blanc sous un éventuel PNG opaque converti en JPEG.
      context.globalCompositeOperation = "destination-over";
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
    }
    return { bytes: await encode(canvas, transparent), width, height };
  } finally {
    bitmap.close();
  }
}

export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/avif"];

export function isImageFile(file: File): boolean {
  return IMAGE_TYPES.includes(file.type) || /\.(jpe?g|png|webp|gif|heic|avif)$/iu.test(file.name);
}
