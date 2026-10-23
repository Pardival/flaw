/** Polices d'écran nommées par D-105. Aucun fichier distant : assets/fonts seulement. */

import { tokens } from "./tokens.ts";

export const FONT_FAMILIES = {
  roman: tokens.font.roman,
  script: tokens.font.script,
  ui: tokens.font.ui,
} as const;

const THIRD_PARTY_HOSTS = [
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "fonts.bunny.net",
  "use.typekit.net",
  "cdn.jsdelivr.net",
  "fastly.jsdelivr.net",
  "unpkg.com",
  "cdnjs.cloudflare.com",
  "fontshare.com",
  "cdn.fontshare.com",
  "kit.fontawesome.com",
  "use.fontawesome.com",
];

export function isThirdPartyFontReference(source: string): boolean {
  const lower = source.toLowerCase();
  if (lower.includes("@fontsource")) {
    return true;
  }
  return THIRD_PARTY_HOSTS.some((host) => lower.includes(host));
}

/** Chemin canonique sous assets/fonts. Refuse une URL et toute remontée. */
export function localFontUrl(relativePath: string): string {
  const normalized = relativePath.trim().replaceAll("\\", "/");
  if (normalized.length === 0 || normalized.split("/").includes("..")) {
    throw new Error("chemin de police invalide");
  }
  if (normalized.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(normalized) || normalized.startsWith("data:")) {
    throw new Error("police hors origine");
  }
  const path = normalized.startsWith("assets/fonts/")
    ? normalized
    : `assets/fonts/${normalized.replace(/^\/+/, "")}`;
  if (!path.startsWith("assets/fonts/") || path.includes("..")) {
    throw new Error("police hors assets/fonts");
  }
  return path;
}
