import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { FONT_FAMILIES, isThirdPartyFontReference, localFontUrl } from "./fonts.ts";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const webRoot = join(repoRoot, "apps/web");
const fontRoot = join(repoRoot, "assets/fonts");

const TEXT_EXTENSIONS = new Set([".css", ".ts", ".tsx", ".html", ".json", ".js", ".mjs", ".svg"]);

function walk(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules" || entry === "dist") {
      continue;
    }
    const path = join(directory, entry);
    const info = statSync(path);
    if (info.isDirectory()) {
      found.push(...walk(path));
    } else if (TEXT_EXTENSIONS.has(entry.slice(entry.lastIndexOf("."))) && !entry.includes(".test.")) {
      found.push(path);
    }
  }
  return found;
}

describe("polices auto-hébergées", () => {
  it("nomme les trois familles données et refuse toute origine tierce", () => {
    expect(FONT_FAMILIES).toEqual({
      roman: "EB Garamond",
      script: "Courier Prime",
      ui: "Inter",
    });
    const packageJson = readFileSync(join(webRoot, "package.json"), "utf8");
    expect(packageJson).not.toContain("i18next");
    expect(packageJson).not.toContain("fontsource");
    expect(JSON.parse(packageJson).dependencies).toEqual({
      react: "19.3.1",
      "react-dom": "19.3.1",
    });

    const files = [...walk(webRoot), ...walk(fontRoot)].filter((path) => !path.endsWith(`${join("theme", "fonts.ts")}`));
    expect(files.length).toBeGreaterThan(0);
    for (const path of files) {
      const source = readFileSync(path, "utf8");
      expect(isThirdPartyFontReference(source), relative(repoRoot, path)).toBe(false);
      expect(source, relative(repoRoot, path)).not.toMatch(/https?:\/\//i);
    }
    expect(isThirdPartyFontReference("https://fonts.googleapis.com/css2?family=Inter")).toBe(true);
    expect(isThirdPartyFontReference("@fontsource/inter")).toBe(true);
  });

  it("n'accepte un fichier de police que sous assets/fonts", () => {
    expect(localFontUrl("eb-garamond/eb-garamond.woff2")).toBe("assets/fonts/eb-garamond/eb-garamond.woff2");
    expect(localFontUrl("assets/fonts/inter/inter.woff2")).toBe("assets/fonts/inter/inter.woff2");
    expect(() => localFontUrl("https://fonts.gstatic.com/inter.woff2")).toThrow(/hors origine/);
    expect(() => localFontUrl("//cdn.example/inter.woff2")).toThrow(/hors origine/);
    expect(() => localFontUrl("../secrets/inter.woff2")).toThrow(/invalide/);
    expect(() => localFontUrl("data:font/woff2;base64,AAAA")).toThrow(/hors origine/);
  });
});
