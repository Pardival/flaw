import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { contrastRatio } from "./contrast.ts";
import { tokens } from "./tokens.ts";

const css = readFileSync(new URL("./design-tokens.css", import.meta.url), "utf8");
const layout = readFileSync(new URL("../layout/layout.css", import.meta.url), "utf8");

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
  it("reprend les mesures officielles du Designer", () => {
    expect(css).toContain(
      '--police-roman: "Flaw Espace Fine", "EB Garamond", "Libre Baskerville", "Crimson Pro", Georgia, serif;',
    );
    expect(css).toContain(
      '--police-script: "Flaw Espace Fine", "Courier Prime", "Courier New", Courier, monospace;',
    );
    expect(css.indexOf('"Flaw Espace Fine"')).toBeLessThan(css.indexOf('"EB Garamond"'));
    expect(css).toContain("--roman-taille: 11.5pt");
    expect(css).toContain("--roman-interligne: 1.42");
    expect(css).toContain("--script-taille: 12pt");
    expect(css).toContain("--taille-ui-xs: 12px");
    expect(css).toContain("--taille-ui-m: 15px");
    expect(css).toContain("--taille-ui-l: 17px");
    expect(css).toContain("--echelle-roman: 1.3");
    expect(css).toContain("--echelle-script: 1.1");
    expect(css).toContain("--echelle-document: 1.22");
    expect(css).toContain("--echelle-page-blanche: 1.12");
    expect(css).toContain("--duree-ui-disparition: 420ms");
    expect(css).toContain("--duree-ui-apparition: 160ms");
    expect(css).toContain("--duree-toast: 4000ms");
    expect(css).toContain("--duree-rappel-focus: 2000ms");
    expect(css).toContain("--duree-theme: 240ms");
    expect(css).toContain("--cible-min: 44px");
    expect(css).toContain("--rupture-tablette: 600px");
    expect(css).toContain("--rupture-ordinateur: 1024px");
    expect(css).toContain("--marges-script: 2.54cm 2.54cm 3.81cm 2.54cm");
    expect(tokens.formats["13x20"].ratio.$value).toBe(0.65);
    expect(tokens.animation.theme.$value).toBe("240ms");
    expect(tokens["points-de-rupture"].tablette.$value).toBe("600px");
    expect(tokens["points-de-rupture"].ordinateur.$value).toBe("1024px");
    expect(tokens.dimensions["cible-tactile-min"].$value).toBe("44px");
    expect(tokens.typographie["polices-par-usage"].roman.defaut).toBe("EB Garamond");
    expect(tokens.typographie["polices-par-usage"].script.defaut).toBe("Courier Prime");
    expect(css).not.toContain("line-height: normal");
    expect(layout).not.toContain("line-height: normal");
  });

  it("aligne le sombre explicite et le mode automatique sur le JSON", () => {
    const light = block(":root {", css);
    const manual = block(':root[data-theme="sombre"]', css);
    const system = block("@media (prefers-color-scheme: dark)", css);
    const reduced = block("@media (prefers-reduced-motion: reduce)", css);
    for (const entry of Object.values(tokens.couleur.clair)) {
      if (typeof entry === "object" && entry !== null && "$value" in entry && String(entry.$value).startsWith("#")) {
        expect(light).toContain(String(entry.$value));
      }
    }
    expect(light).not.toContain(tokens.couleur.sombre.encre.$value);
    for (const hex of [
      tokens.couleur.sombre.papier.$value,
      tokens.couleur.sombre.bureau.$value,
      tokens.couleur.sombre.encre.$value,
      tokens.couleur.sombre.accent.$value,
    ]) {
      expect(manual).toContain(hex);
      expect(system).toContain(hex);
    }
    expect(system).toContain(":root:not([data-theme])");
    expect(system).not.toContain('[data-theme="clair"]');
    expect(reduced).toContain("--duree-theme: 0ms");
    expect(reduced).not.toContain("--duree-rappel-focus: 0ms");
  });

  it("garde un contraste AA pour l'encre, le texte secondaire et l'accent", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBe(21);
    for (const palette of [tokens.couleur.clair, tokens.couleur.sombre]) {
      expect(contrastRatio(palette.encre.$value, palette.papier.$value)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(palette["encre-2"].$value, palette.papier.$value)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(palette["encre-3"].$value, palette.papier.$value)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(palette.accent.$value, palette.papier.$value)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(palette["sur-accent"].$value, palette.accent.$value)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(palette.encre.$value, palette.bureau.$value)).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrastRatio(tokens.couleur.clair["encre-3"].$value, tokens.couleur.clair.bureau.$value)).toBeGreaterThanOrEqual(
      4.5,
    );
  });
});
