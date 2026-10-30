import { execFileSync } from "node:child_process";
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
    if (entry === "node_modules" || entry === "dist" || entry === "dist-desktop") {
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
    expect(packageJson).not.toContain("fontsource");
    expect(packageJson).not.toMatch(/"i18next"\s*:\s*"[\^~]/);
    expect(packageJson).not.toMatch(/"react-i18next"\s*:\s*"[\^~]/);
    const dependencies = JSON.parse(packageJson).dependencies as Record<string, string>;
    expect(dependencies).toMatchObject({
      dexie: "4.4.6",
      i18next: "26.4.7",
      react: "19.3.1",
      "react-dom": "19.3.1",
      "react-i18next": "17.0.20",
      "y-indexeddb": "9.0.12",
      yjs: "13.6.33",
    });
    // Versions exactes pour toutes les dépendances, y compris celles ajoutées depuis.
    for (const [name, version] of Object.entries(dependencies)) {
      expect(version, name).toMatch(/^(\d+\.\d+\.\d+|workspace:\*)$/);
    }

    const files = [...walk(webRoot), ...walk(fontRoot)].filter((path) => !path.endsWith(`${join("theme", "fonts.ts")}`));
    expect(files.length).toBeGreaterThan(0);
    for (const path of files) {
      const source = readFileSync(path, "utf8");
      expect(isThirdPartyFontReference(source), relative(repoRoot, path)).toBe(false);
      // L'espace de noms SVG n'est pas une requête réseau,
      // Ni le proxy de développement local.
      const fetched = source.replaceAll('xmlns="http://www.w3.org/2000/svg"', "").replaceAll("http://127.0.0.1:3000", "");
      expect(fetched, relative(repoRoot, path)).not.toMatch(/https?:\/\//i);
    }
    expect(isThirdPartyFontReference("https://fonts.googleapis.com/css2?family=Inter")).toBe(true);
    expect(isThirdPartyFontReference("@fontsource/inter")).toBe(true);
  });

  it("vérifie les empreintes et le romain 700 distinct", () => {
    execFileSync("sha256sum", ["-c", "SHA256SUMS"], { cwd: fontRoot, stdio: "pipe" });
    const sums = readFileSync(join(fontRoot, "SHA256SUMS"), "utf8");
    const css = readFileSync(join(fontRoot, "polices.css"), "utf8");
    const hash = (name: string) => {
      const line = sums.split("\n").find((entry) => entry.endsWith(`  ${name}`));
      if (line === undefined) {
        throw new Error(`empreinte absente : ${name}`);
      }
      return line.slice(0, 64);
    };
    expect(hash("EBGaramond-normal-700.woff2")).not.toBe(hash("EBGaramond-normal-400.woff2"));
    expect(hash("EBGaramond-normal-700-ext.woff2")).not.toBe(hash("EBGaramond-normal-400-ext.woff2"));
    expect(hash("EBGaramond-normal-400.woff2")).toBe(hash("EBGaramond-normal-600.woff2"));
    expect(css).toContain("src: url(EBGaramond-normal-700.woff2) format('woff2');");
    expect(css).toContain("src: url(EBGaramond-normal-700-ext.woff2) format('woff2');");
    expect(css).toContain("font-weight: 700;");
    expect(css).not.toContain("font-weight: 400 800");
    expect(css).toContain("unicode-range: U+202F;");
    expect(css).toContain("font-family: 'Flaw Espace Fine';");
    expect(css).toContain("src: url(SourceSerif4-Regular.ttf.woff2) format('woff2');");
    const licenses: Array<[string, string]> = [
      ["OFL-CourierPrime.txt", "Copyright 2015 The Courier Prime Project Authors"],
      ["OFL-CrimsonPro.txt", "Copyright 2018 The Crimson Pro Project Authors"],
      ["OFL-EBGaramond.txt", "Copyright 2017 The EB Garamond Project Authors"],
      ["OFL-IBMPlexSans.txt", 'Copyright © 2017 IBM Corp. with Reserved Font Name "Plex"'],
      ["OFL-Inter.txt", "Copyright 2020 The Inter Project Authors"],
      [
        "OFL-LibreBaskerville.txt",
        "Copyright 2012 The Libre Baskerville Project Authors",
      ],
      ["OFL-Literata.txt", "Copyright 2017 The Literata Project Authors"],
      ["OFL-Lora.txt", 'Copyright 2011 The Lora Project Authors'],
      ["OFL-SourceSans3.txt", "Copyright 2010-2020 Adobe"],
      ["OFL-SourceSerif4.md", "Copyright 2014 - 2023 Adobe"],
    ];
    for (const [name, copyright] of licenses) {
      const text = readFileSync(join(fontRoot, name), "utf8");
      expect(text.startsWith(copyright), name).toBe(true);
      expect(text, name).toContain("SIL OPEN FONT LICENSE Version 1.1");
      expect(text.length, name).toBeGreaterThan(4000);
    }
    expect(readFileSync(join(fontRoot, "OFL-LibreBaskerville.txt"), "utf8")).toContain(
      "Reserved Font Name Libre Baskerville",
    );
    expect(readFileSync(join(fontRoot, "OFL-Lora.txt"), "utf8")).toContain('Reserved Font Name "Lora"');
    expect(readFileSync(join(fontRoot, "OFL-SourceSans3.txt"), "utf8")).toContain("Reserved Font Name 'Source'");
    expect(readFileSync(join(fontRoot, "OFL-SourceSerif4.md"), "utf8")).toContain("Reserved Font Name");
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
