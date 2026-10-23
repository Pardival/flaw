import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { t } from "../i18n/i18n.ts";
import {
  THEME_STORAGE_KEY,
  applyThemeChoice,
  readChoice,
  resolveTheme,
  toggleTheme,
  writeChoice,
  type ThemeStorage,
} from "./theme.ts";

function memory(): ThemeStorage & { dump: Map<string, string> } {
  const dump = new Map<string, string>();
  return {
    dump,
    getItem(key) {
      return dump.get(key) ?? null;
    },
    setItem(key, value) {
      dump.set(key, value);
    },
  };
}

describe("thème", () => {
  it("suit prefers-color-scheme tant qu'aucun choix n'est enregistré", () => {
    expect(readChoice(null)).toBe("auto");
    expect(readChoice(memory())).toBe("auto");
    expect(resolveTheme("auto", false)).toBe("clair");
    expect(resolveTheme("auto", true)).toBe("sombre");
    const root = { dataset: {} as { theme?: string } };
    expect(applyThemeChoice(root, "auto", true)).toBe("sombre");
    expect(root.dataset.theme).toBeUndefined();
  });

  it("persiste clair ou sombre et pose l'attribut, y compris en clair explicite", () => {
    const storage = memory();
    writeChoice(storage, "sombre");
    expect(storage.dump.get(THEME_STORAGE_KEY)).toBe("sombre");
    expect(readChoice(storage)).toBe("sombre");
    expect(resolveTheme("sombre", false)).toBe("sombre");
    expect(toggleTheme("sombre", true)).toBe("clair");
    expect(toggleTheme("auto", true)).toBe("clair");
    expect(toggleTheme("auto", false)).toBe("sombre");
    const root = { dataset: {} as { theme?: string } };
    expect(applyThemeChoice(root, "clair", true)).toBe("clair");
    expect(root.dataset.theme).toBe("clair");
    expect(applyThemeChoice(root, "sombre", false)).toBe("sombre");
    expect(root.dataset.theme).toBe("sombre");
  });

  it("revient au mode automatique si la valeur stockée est inconnue ou illisible", () => {
    const storage = memory();
    storage.dump.set(THEME_STORAGE_KEY, "bleu");
    expect(readChoice(storage)).toBe("auto");
    const broken: ThemeStorage = {
      getItem() {
        throw new Error("stockage refusé");
      },
      setItem() {
        throw new Error("stockage refusé");
      },
    };
    expect(readChoice(broken)).toBe("auto");
  });

  it("nomme la bascule en français dans le catalogue, pas dans le composant", () => {
    expect(t("theme:themeToDark")).toBe("Passer au thème sombre");
    expect(t("theme:themeToLight")).toBe("Passer au thème clair");
    const files = readdirSync(new URL(".", import.meta.url)).filter((name) => name.endsWith(".tsx"));
    for (const name of files) {
      const source = readFileSync(new URL(name, import.meta.url), "utf8");
      expect(source, name).not.toContain("thème");
      expect(source, name).not.toContain("localStorage");
      expect(source, name).not.toContain("document.cookie");
    }
  });
});
