import { META_MAP } from "@flaw/sync/src/index.ts";
import type * as Y from "yjs";

/**
 * Couverture d'un texte (1re et 4e), rangée dans les métadonnées du Y.Doc : elle
 * suit le texte (historique, sauvegarde) ; ses images vivent dans la carte assets.
 */
export const COVER_TEMPLATES = ["classic", "photo", "band", "minimal"] as const;
export type CoverTemplate = (typeof COVER_TEMPLATES)[number];

export const COVER_FONTS = ["EB Garamond", "Libre Baskerville", "Inter", "Courier Prime"] as const;
export type CoverFont = (typeof COVER_FONTS)[number];

/** Fond / encre ; contrastes vérifiés à l'œil sur papier et à l'écran. */
export const COVER_PALETTES = [
  { key: "paper", background: "#F4EEE3", ink: "#26231F", accent: "#2F5873" },
  { key: "ink", background: "#1F1D1A", ink: "#F4EEE3", accent: "#E8C27A" },
  { key: "sea", background: "#2F5873", ink: "#F7F3EA", accent: "#E8C27A" },
  { key: "wine", background: "#6E2A2A", ink: "#F7EFE6", accent: "#E9C9A0" },
  { key: "forest", background: "#34493A", ink: "#F3F0E6", accent: "#D9C58C" },
  { key: "sand", background: "#E3C58F", ink: "#2A2520", accent: "#6E2A2A" },
] as const;
export type CoverPalette = (typeof COVER_PALETTES)[number]["key"];

export type CoverImage = { asset: string; original: string | null; crop: [number, number, number, number] | null };

export type Cover = {
  template: CoverTemplate;
  palette: CoverPalette;
  font: CoverFont;
  title: string;
  subtitle: string;
  author: string;
  image: CoverImage | null;
  backText: string;
  backShowTitle: boolean;
};

export const COVER_KEY = "cover";
export const BACK_TEXT_MAX = 1500;

export function defaultCover(title: string): Cover {
  return {
    template: "classic",
    palette: "paper",
    font: "EB Garamond",
    title,
    subtitle: "",
    author: "",
    image: null,
    backText: "",
    backShowTitle: true,
  };
}

function oneOf<T extends string>(value: unknown, list: readonly T[], fallback: T): T {
  return typeof value === "string" && (list as readonly string[]).includes(value) ? (value as T) : fallback;
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function readImage(value: unknown): CoverImage | null {
  if (typeof value !== "object" || value === null) return null;
  const item = value as Record<string, unknown>;
  const id = /^[0-9a-f]{32}$/u;
  if (typeof item.asset !== "string" || !id.test(item.asset)) return null;
  const original = typeof item.original === "string" && id.test(item.original) ? item.original : null;
  const crop =
    Array.isArray(item.crop) && item.crop.length === 4 && item.crop.every((part) => typeof part === "number" && part >= 0 && part <= 1)
      ? (item.crop as [number, number, number, number])
      : null;
  return { asset: item.asset, original, crop };
}

export function readCover(doc: Y.Doc): Cover | null {
  const raw = doc.getMap<unknown>(META_MAP).get(COVER_KEY);
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  return {
    template: oneOf(value.template, COVER_TEMPLATES, "classic"),
    palette: oneOf(value.palette, COVER_PALETTES.map((item) => item.key), "paper"),
    font: oneOf(value.font, COVER_FONTS, "EB Garamond"),
    title: text(value.title, 200),
    subtitle: text(value.subtitle, 200),
    author: text(value.author, 120),
    image: readImage(value.image),
    backText: text(value.backText, BACK_TEXT_MAX),
    backShowTitle: value.backShowTitle !== false,
  };
}

export function writeCover(doc: Y.Doc, cover: Cover | null): void {
  const map = doc.getMap<unknown>(META_MAP);
  if (cover === null) map.delete(COVER_KEY);
  else map.set(COVER_KEY, { ...cover });
}

export function paletteOf(cover: Cover): (typeof COVER_PALETTES)[number] {
  return COVER_PALETTES.find((item) => item.key === cover.palette) ?? COVER_PALETTES[0];
}

/** Fichiers désignés par la couverture (pour ne pas les élaguer). */
export function coverAssets(cover: Cover | null): string[] {
  if (cover?.image == null) return [];
  return [cover.image.asset, ...(cover.image.original ? [cover.image.original] : [])];
}
