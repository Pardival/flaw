import { readdirSync, readFileSync } from "node:fs";

import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { messages } from "../theme/messages.fr.ts";
import { tokens } from "../theme/tokens.ts";
import {
  chromeStaysHidden,
  isTypingKey,
  keyboardClosed,
  pointerWakesChrome,
  revealDelta,
  scrolledUp,
  shouldHideChromeOnKey,
} from "./chrome.ts";
import { pageRatio } from "./formats.ts";
import { Shell } from "./Shell.tsx";

function html(node: ReactNode): string {
  return renderToStaticMarkup(node);
}

describe("mise en page", () => {
  it("pose la page fluide sous 600 px et les proportions à partir de 600 et 1024 px", () => {
    const css = readFileSync(new URL("./layout.css", import.meta.url), "utf8");
    expect(tokens.breakpoint.tabletPx).toBe(600);
    expect(tokens.breakpoint.desktopPx).toBe(1024);
    expect(css).toContain("max-width: 599.98px");
    expect(css).toContain("min-width: 600px");
    expect(css).toContain("min-width: 1024px");
    expect(css).toContain("var(--font-size-phone-body)");
    expect(css).toContain("var(--target-min)");
    expect(css).toContain("var(--margin-script-left)");
    expect(css).toContain("scroll-margin-bottom");
    expect(css).toContain("scroll-padding-bottom");
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(pageRatio("novel_13x20")).toBeCloseTo(130 / 200);
    expect(pageRatio("us_letter")).toBeCloseTo(215.9 / 279.4);
    for (const [name, size] of Object.entries(tokens.page.formats)) {
      expect(css).toContain(`[data-format="${name}"] { --page-ratio: ${size.widthMm} / ${size.heightMm}; }`);
    }
  });

  it("garde le chrome visible hors page blanche au focus, et le réveille au-delà de 6 px", () => {
    expect(chromeStaysHidden("blank", true)).toBe(true);
    expect(chromeStaysHidden("blank", false)).toBe(false);
    expect(chromeStaysHidden("novel", true)).toBe(false);
    expect(isTypingKey("a", { meta: false, ctrl: false, alt: false })).toBe(true);
    expect(isTypingKey("Tab", { meta: false, ctrl: false, alt: false })).toBe(false);
    expect(isTypingKey("a", { meta: true, ctrl: false, alt: false })).toBe(false);
    expect(shouldHideChromeOnKey(true, false, false)).toBe(true);
    expect(shouldHideChromeOnKey(true, true, false)).toBe(false);
    expect(shouldHideChromeOnKey(false, false, true)).toBe(true);
    expect(pointerWakesChrome(3, 4, tokens.target.pointerWakePx)).toBe(false);
    expect(pointerWakesChrome(7, 0, tokens.target.pointerWakePx)).toBe(true);
    expect(pointerWakesChrome(6, 0, 6)).toBe(false);
    expect(keyboardClosed(400, 720)).toBe(true);
    expect(keyboardClosed(720, 400)).toBe(false);
    expect(scrolledUp(200, 120)).toBe(true);
    expect(scrolledUp(120, 200)).toBe(false);
    expect(revealDelta(700, 0, 500, 24)).toBe(224);
    expect(revealDelta(400, 0, 500, 24)).toBe(0);
  });

  it("affiche la bascule de thème dans le bureau et cache le chrome sur la page blanche", () => {
    const desk = html(
      <Shell>
        <p>page</p>
      </Shell>,
    );
    expect(desk).toContain('data-chrome-hidden="false"');
    expect(desk).toContain('data-format="novel_13x20"');
    expect(desk).toContain('class="theme-toggle"');
    expect(desk).toContain(messages.themeToDark);
    expect(desk).not.toContain("style=");
    const blank = html(
      <Shell mode="blank" pageFocused>
        <p>rien</p>
      </Shell>,
    );
    expect(blank).toContain('data-chrome-hidden="true"');
    expect(blank).toContain('data-mode="blank"');
  });

  it("laisse les phrases françaises dans le catalogue", () => {
    const files = readdirSync(new URL(".", import.meta.url)).filter(
      (name) => name.endsWith(".tsx") && !name.endsWith(".test.tsx"),
    );
    for (const name of files) {
      const source = readFileSync(new URL(name, import.meta.url), "utf8");
      expect(source, name).not.toContain("thème");
      expect(source, name).not.toContain("localStorage");
      expect(source, name).not.toContain("document.cookie");
    }
  });
});
