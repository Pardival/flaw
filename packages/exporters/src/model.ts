/**
 * Document structuré d'entrée (JSON ProseMirror de @flaw/schema), jamais du HTML (A-016).
 * Isomorphe : aucun accès au DOM, utilisable en Web Worker et sur le serveur.
 */
export type Mark = { type: string; attrs?: Record<string, unknown> };
export type PMJson = { type: string; attrs?: Record<string, unknown>; content?: PMJson[]; text?: string; marks?: Mark[] };

export type ExportMode = "novel" | "screenplay" | "document" | "blank";
export type ExportFormat = "novel_13x20" | "pocket_11x17_8" | "trade_15x23" | "a5" | "a4" | "us_letter";

/** Fichier du texte joint à l'export (image, couverture rendue en JPEG). */
export type ExportAsset = { bytes: Uint8Array; kind: "jpeg" | "png" };

export type ExportInput = {
  title: string;
  author?: string;
  mode: ExportMode;
  pageFormat: ExportFormat;
  lang: string;
  fontFamily?: string;
  baseFontSizePt?: number;
  doc: PMJson;
  /** Images désignées par le texte (attribut `asset`), par empreinte. */
  assets?: Record<string, ExportAsset>;
  /** 1re et 4e de couverture, déjà rendues à la taille de la page. */
  cover?: { front?: ExportAsset; back?: ExportAsset };
};

export type ImageAttrs = { asset: string; width: number; ratio: number; align: "left" | "center" | "right"; alt: string };

export function imageAttrs(node: PMJson): ImageAttrs | null {
  const attrs = node.attrs ?? {};
  if (typeof attrs.asset !== "string" || !/^[0-9a-f]{32}$/u.test(attrs.asset)) return null;
  const width = typeof attrs.width === "number" ? Math.min(100, Math.max(10, attrs.width)) : 60;
  const ratio = typeof attrs.ratio === "number" && attrs.ratio > 0 ? attrs.ratio : 0.75;
  const align = attrs.align === "left" || attrs.align === "right" ? attrs.align : "center";
  return { asset: attrs.asset, width, ratio, align, alt: typeof attrs.alt === "string" ? attrs.alt : "" };
}

export function extensionOf(asset: ExportAsset): "jpg" | "png" {
  return asset.kind === "png" ? "png" : "jpg";
}

export type Run = { text: string; bold: boolean; italic: boolean; sizePt: number | null; lineBreak: boolean };

export const PAGE_MM: Record<ExportFormat, { width: number; height: number }> = {
  novel_13x20: { width: 130, height: 200 },
  pocket_11x17_8: { width: 110, height: 178 },
  trade_15x23: { width: 150, height: 230 },
  a5: { width: 148, height: 210 },
  a4: { width: 210, height: 297 },
  us_letter: { width: 215.9, height: 279.4 },
};

/** Marges (jetons --marges-*), mm : haut, extérieur/droite, bas, intérieur/gauche. */
export const MARGINS_MM: Record<ExportFormat, [number, number, number, number]> = {
  novel_13x20: [20, 24, 20, 16],
  pocket_11x17_8: [16, 20, 17, 13],
  trade_15x23: [22, 26, 22, 18],
  a5: [20, 24, 20, 17],
  a4: [25, 25, 25, 25],
  us_letter: [25.4, 25.4, 25.4, 25.4],
};

export const SCRIPT_MARGINS_MM: [number, number, number, number] = [25.4, 25.4, 25.4, 38.1];

export const DEFAULT_FONT: Record<ExportMode, string> = {
  novel: "EB Garamond",
  screenplay: "Courier Prime",
  document: "Inter",
  blank: "Source Serif 4",
};

export const DEFAULT_SIZE: Record<ExportMode, number> = { novel: 11.5, screenplay: 12, document: 10.5, blank: 12 };

export function runsOf(node: PMJson): Run[] {
  const runs: Run[] = [];
  for (const child of node.content ?? []) {
    if (child.type === "hard_break") {
      runs.push({ text: "", bold: false, italic: false, sizePt: null, lineBreak: true });
      continue;
    }
    if (child.type !== "text" || typeof child.text !== "string") {
      continue;
    }
    const marks = child.marks ?? [];
    const size = marks.find((mark) => mark.type === "font_size")?.attrs?.pt;
    runs.push({
      text: child.text,
      bold: marks.some((mark) => mark.type === "bold"),
      italic: marks.some((mark) => mark.type === "italic"),
      sizePt: typeof size === "number" ? size : null,
      lineBreak: false,
    });
  }
  return runs;
}

export function plainText(node: PMJson): string {
  if (node.type === "text") {
    return node.text ?? "";
  }
  if (node.type === "hard_break") {
    return "\n";
  }
  return (node.content ?? []).map(plainText).join("");
}

export function alignOf(node: PMJson): "left" | "center" | "right" | "justify" | null {
  const value = node.attrs?.align;
  return value === "left" || value === "center" || value === "right" || value === "justify" ? value : null;
}

/** Retire les caractères de contrôle (sauf tabulation et sauts de ligne si `keepLines`). */
function stripControls(text: string, keepLines: boolean): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const control = code < 0x20 || code === 0x7f;
    if (!control || (keepLines && (code === 0x09 || code === 0x0a || code === 0x0d))) {
      out += char;
    }
  }
  return out;
}

/** Nom de fichier sûr (SEC-WEB-09) : pas de séparateur, de caractère de contrôle ni de nom réservé. */
export function safeFileName(title: string, extension: string): string {
  const base = stripControls(title.normalize("NFC"), false)
    .replace(/[<>:"/\\|?*]+/gu, " ")
    .replace(/[\s\u00a0\u202f]+/gu, " ")
    .trim()
    .replace(/^\.+/u, "")
    .slice(0, 120);
  const reserved = /^(con|prn|aux|nul|com\d|lpt\d)$/iu.test(base);
  return `${base.length === 0 || reserved ? "texte" : base}.${extension}`;
}

/** Échappement XML (EPUB) : texte et attributs. */
export function xml(text: string): string {
  return stripControls(text, true)
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}
