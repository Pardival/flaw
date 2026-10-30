import { META_MAP } from "@flaw/sync/src/index.ts";
import { useEffect, useState } from "react";
import type * as Y from "yjs";

/**
 * Métadonnées du texte dans le Y.Doc (A-008 `meta`) : langue, typographie française,
 * police, taille. Synchronisées comme le contenu ; une valeur gagne en cas de conflit.
 */
export type TextMeta = {
  lang: TextLang;
  frenchTypography: boolean | null;
  fontFamily: string | null;
  baseFontSizePt: number | null;
};

/** Langues d'un texte (césure, correcteur, export). La typographie française ne vaut qu'en français. */
export const LANGS = ["fr", "en", "es", "de", "it", "pt"] as const;
export type TextLang = (typeof LANGS)[number];

export function isTextLang(value: unknown): value is TextLang {
  return typeof value === "string" && (LANGS as readonly string[]).includes(value);
}

/** Nom de chaque langue dans cette langue. */
export const LANG_NAMES: Record<TextLang, string> = {
  fr: "Français",
  en: "English",
  es: "Español",
  de: "Deutsch",
  it: "Italiano",
  pt: "Português",
};

export function readMeta(doc: Y.Doc): TextMeta {
  const map = doc.getMap<unknown>(META_MAP);
  const lang = map.get("lang");
  const french = map.get("frenchTypography");
  const font = map.get("fontFamily");
  const size = map.get("baseFontSizePt");
  return {
    lang: isTextLang(lang) ? lang : "fr",
    frenchTypography: typeof french === "boolean" ? french : null,
    fontFamily: typeof font === "string" ? font : null,
    baseFontSizePt: typeof size === "number" ? size : null,
  };
}

export function writeMeta(doc: Y.Doc, patch: Partial<TextMeta>): void {
  const map = doc.getMap<unknown>(META_MAP);
  doc.transact(() => {
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === undefined) {
        map.delete(key);
      } else {
        map.set(key, value);
      }
    }
  });
}

export function useMeta(doc: Y.Doc | null): TextMeta | null {
  const [meta, setMeta] = useState<TextMeta | null>(() => (doc ? readMeta(doc) : null));
  useEffect(() => {
    if (!doc) {
      setMeta(null);
      return;
    }
    const map = doc.getMap<unknown>(META_MAP);
    const update = () => {
      setMeta(readMeta(doc));
    };
    update();
    map.observe(update);
    return () => {
      map.unobserve(update);
    };
  }, [doc]);
  return meta;
}

/** Typographie française active : texte en français et réglage du texte, sinon réglage général (AC-074). */
export function frenchTypographyOn(meta: TextMeta, general: boolean): boolean {
  return meta.lang === "fr" && (meta.frenchTypography ?? general);
}
