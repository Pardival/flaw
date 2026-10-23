import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { account } from "./fr/account.ts";
import { auth } from "./fr/auth.ts";
import { mfa } from "./fr/mfa.ts";
import { theme } from "./fr/theme.ts";
import i18n, { defaultLanguage, t } from "./i18n.ts";

const directImport = /(?:from|import)\s*\(?\s*["'][^"']*messages\.fr\.ts["']/;

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (name.endsWith(".ts") || name.endsWith(".tsx")) {
      found.push(path);
    }
  }
  return found;
}

function leaves(value: unknown, prefix = ""): [string, string][] {
  if (typeof value === "string") {
    return prefix.length > 0 ? [[prefix, value]] : [];
  }
  if (value === null || typeof value !== "object") {
    return [];
  }
  return Object.entries(value).flatMap(([key, nested]) => leaves(nested, prefix.length > 0 ? `${prefix}.${key}` : key));
}

describe("catalogues i18next", () => {
  it("sert le français par défaut, avec les mêmes clés que les anciens catalogues", () => {
    expect(defaultLanguage).toBe("fr");
    expect(i18n.language).toBe("fr");
    expect(i18n.options.fallbackLng).toEqual(["fr"]);
    const catalogs = { auth, mfa, account, theme };
    for (const [ns, catalog] of Object.entries(catalogs)) {
      for (const [key, value] of leaves(catalog)) {
        if (value.includes("{{")) {
          continue;
        }
        expect(t(`${ns}:${key}`), `${ns}:${key}`).toBe(value);
      }
    }
    expect(t("auth:passwordHint", { min: 15 })).toBe("15 caractères minimum");
    expect(t("auth:passwordCounter", { current: 0, min: 15 })).toBe("0 caractères sur 15 minimum");
    expect(t("auth:passwordCounter", { current: 12, min: 15 })).toBe("12 caractères sur 15 minimum");
    expect(t("account:passwordCounter", { current: 12, min: 15 })).toBe("12 caractères sur 15 minimum");
    expect(t("mfa:openApp")).toBe("Ouvrir l'application");
    expect(t("account:deviceType.phone")).toBe("Téléphone");
    expect(t("theme:themeToDark")).toBe("Passer au thème sombre");
    expect(t("theme:themeToLight")).toBe("Passer au thème clair");
  });

  it("n'importe plus messages.fr.ts", () => {
    const root = new URL("..", import.meta.url);
    const files = sourceFiles(root.pathname);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file.endsWith("messages.fr.ts"), file).toBe(false);
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(directImport);
    }
  });
});
