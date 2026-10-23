import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { messages } from "./messages.fr.ts";
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
    expect(readChoice(null)).toBe("system");
    expect(readChoice(memory())).toBe("system");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("system", true)).toBe("dark");
    const root = { dataset: {} as { theme?: string } };
    expect(applyThemeChoice(root, "system", true)).toBe("dark");
    expect(root.dataset.theme).toBeUndefined();
  });

  it("persiste la bascule manuelle et ignore le schéma système ensuite", () => {
    const storage = memory();
    writeChoice(storage, "dark");
    expect(storage.dump.get(THEME_STORAGE_KEY)).toBe("dark");
    expect(readChoice(storage)).toBe("dark");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(toggleTheme("dark", true)).toBe("light");
    expect(toggleTheme("system", true)).toBe("light");
    expect(toggleTheme("system", false)).toBe("dark");
    const root = { dataset: {} as { theme?: string } };
    expect(applyThemeChoice(root, "light", true)).toBe("light");
    expect(root.dataset.theme).toBe("light");
  });

  it("revient au système si la valeur stockée est inconnue ou illisible", () => {
    const storage = memory();
    storage.dump.set(THEME_STORAGE_KEY, "bleu");
    expect(readChoice(storage)).toBe("system");
    const broken: ThemeStorage = {
      getItem() {
        throw new Error("stockage refusé");
      },
      setItem() {
        throw new Error("stockage refusé");
      },
    };
    expect(readChoice(broken)).toBe("system");
  });

  it("nomme la bascule en français dans le catalogue, pas dans le composant", () => {
    expect(messages.themeToDark).toBe("Passer au thème sombre");
    expect(messages.themeToLight).toBe("Passer au thème clair");
    const files = readdirSync(new URL(".", import.meta.url)).filter((name) => name.endsWith(".tsx"));
    for (const name of files) {
      const source = readFileSync(new URL(name, import.meta.url), "utf8");
      expect(source, name).not.toContain("thème");
      expect(source, name).not.toContain("localStorage");
      expect(source, name).not.toContain("document.cookie");
    }
  });
});
