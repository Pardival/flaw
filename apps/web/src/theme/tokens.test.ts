import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { contrastRatio } from "./contrast.ts";
import { tokens } from "./tokens.ts";

const css = readFileSync(new URL("./design-tokens.css", import.meta.url), "utf8");

function block(selector: string, source: string): string {
  const start = source.indexOf(selector);
  if (start < 0) {
    throw new Error(`sélecteur absent : ${selector}`);
  }
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") {
      depth += 1;
    } else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(open + 1, index);
      }
    }
  }
  throw new Error(`bloc non fermé : ${selector}`);
}

describe("jetons de design", () => {
  it("reproduit dans le CSS les mesures données par D-105 et D-101", () => {
    expect(css).toContain(`--font-roman: "${tokens.font.roman}"`);
    expect(css).toContain(`--font-script: "${tokens.font.script}"`);
    expect(css).toContain(`--font-ui: ${tokens.font.ui},`);
    expect(css).toContain(`--font-size-roman: ${tokens.font.romanSizePt}pt`);
    expect(css).toContain(`--leading-roman: ${tokens.font.romanLineHeight}`);
    expect(css).toContain(`--font-size-script: ${tokens.font.scriptSizePt}pt`);
    expect(css).toContain(`--font-size-ui-min: ${tokens.font.uiMinPx}px`);
    expect(css).toContain(`--font-size-ui: ${tokens.font.uiMaxPx}px`);
    expect(css).toContain(`--font-size-phone-body: ${tokens.font.phoneBodyPx}px`);
    expect(css).toContain(`--scale-novel: ${tokens.scale.novel}`);
    expect(css).toContain(`--scale-screenplay: ${tokens.scale.screenplay}`);
    expect(css).toContain(`--scale-document: ${tokens.scale.document}`);
    expect(css).toContain(`--scale-blank: ${tokens.scale.blank}`);
    expect(css).toContain(`--duration-ui-hide: ${tokens.duration.uiHideMs}ms`);
    expect(css).toContain(`--duration-ui: ${tokens.duration.uiMs}ms`);
    expect(css).toContain(`--duration-toast: ${tokens.duration.toastMs}ms`);
    expect(css).toContain(`--duration-focus-reminder: ${tokens.duration.focusReminderMs}ms`);
    expect(css).toContain(`--target-min: ${tokens.target.minPx}px`);
    expect(css).toContain(`--pointer-wake: ${tokens.target.pointerWakePx}px`);
    expect(css).toContain(`--margin-script-left: ${tokens.page.screenplayMarginsIn.left}in`);
    expect(css).toContain(`--margin-script-right: ${tokens.page.screenplayMarginsIn.right}in`);
    expect(tokens.font.romanSizePt).toBe(11.5);
    expect(tokens.font.romanLineHeight).toBe(1.42);
    expect(tokens.font.scriptSizePt).toBe(12);
    expect(tokens.font.uiMinPx).toBe(12);
    expect(tokens.font.uiMaxPx).toBe(15);
    expect(tokens.font.phoneBodyPx).toBe(19);
    expect(tokens.scale).toEqual({ novel: 1.3, screenplay: 1.1, document: 1.22, blank: 1.12 });
    expect(tokens.breakpoint).toEqual({ tabletPx: 600, desktopPx: 1024 });
    expect(tokens.duration).toEqual({ uiHideMs: 420, uiMs: 160, toastMs: 4000, focusReminderMs: 2000 });
    expect(tokens.target).toEqual({ minPx: 44, pointerWakePx: 6 });
    expect(tokens.page.screenplayMarginsIn).toEqual({ top: 1, right: 1, bottom: 1, left: 1.5 });
  });

  it("aligne les couleurs du CSS sur le JSON, y compris le suivi du schéma sombre", () => {
    const light = block(":root {", css);
    const manual = block(':root[data-theme="dark"]', css);
    const system = block("@media (prefers-color-scheme: dark)", css);
    for (const hex of Object.values(tokens.color.light)) {
      if (hex.startsWith("#")) {
        expect(light).toContain(hex);
      }
    }
    expect(light).toContain(tokens.color.light.focusExit);
    expect(light).not.toContain(tokens.color.dark.ink);
    for (const hex of [tokens.color.dark.paper, tokens.color.dark.desk, tokens.color.dark.ink, tokens.color.dark.accent]) {
      expect(manual).toContain(hex);
      expect(system).toContain(hex);
    }
    expect(system).toContain(':root:not([data-theme="light"])');
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(block("@media (prefers-reduced-motion: reduce)", css)).toContain("--duration-ui-hide: 0ms");
  });

  it("garde un contraste AA pour l'encre, le texte atténué et l'accent", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBe(21);
    for (const palette of [tokens.color.light, tokens.color.dark]) {
      expect(contrastRatio(palette.ink, palette.paper)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(palette.inkMuted, palette.paper)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(palette.accent, palette.paper)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(palette.ink, palette.desk)).toBeGreaterThanOrEqual(4.5);
    }
    expect(tokens.color.light.focusExit).toContain("22%");
    expect(tokens.color.dark.focusExit).toContain("22%");
  });

  it("fixe les formats de page déjà nommés par le contrat", () => {
    expect(tokens.page.formats).toEqual({
      novel_13x20: { widthMm: 130, heightMm: 200 },
      pocket_11x17_8: { widthMm: 110, heightMm: 178 },
      trade_15x23: { widthMm: 150, heightMm: 230 },
      a5: { widthMm: 148, heightMm: 210 },
      a4: { widthMm: 210, heightMm: 297 },
      us_letter: { widthMm: 215.9, heightMm: 279.4 },
    });
  });
});
