import { readFileSync } from "node:fs";

import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { App } from "./App.tsx";
import type { MfaPhase } from "./auth-ui/mfa/phase.ts";
import type { AuthPhase } from "./auth-ui/phase.ts";
import { t } from "./i18n/i18n.ts";

function html(node: ReactNode): string {
  return renderToStaticMarkup(node).replaceAll("&#x27;", "'");
}

const screens: { phase: AuthPhase; marker: string }[] = [
  { phase: { name: "loading" }, marker: t("auth:loading") },
  { phase: { name: "connexion", notice: null }, marker: 'data-screen="connexion"' },
  { phase: { name: "connexion-mdp-oublie", notice: "credential" }, marker: 'data-screen="connexion-mdp-oublie"' },
  { phase: { name: "nouveau-mot-de-passe", notice: null }, marker: 'data-screen="nouveau-mot-de-passe"' },
  {
    phase: { name: "reconnexion-necessaire", notice: null, forgot: false },
    marker: 'data-screen="reconnexion-necessaire"',
  },
];

describe("App monte les écrans d'auth", () => {
  it("rend chaque écran existant depuis App et cache le travail local tant que la session n'est pas prête", () => {
    for (const screen of screens) {
      const page = html(
        <App initialPhase={screen.phase}>
          <p>texte secret</p>
        </App>,
      );
      expect(page, screen.phase.name).toContain(screen.marker);
      expect(page, screen.phase.name).toContain('class="desk"');
      if (screen.phase.name === "reconnexion-necessaire") {
        expect(page).toContain("texte secret");
      } else {
        expect(page, screen.phase.name).not.toContain("texte secret");
      }
    }
    const ready = html(
      <App initialPhase={{ name: "ready" }}>
        <p>texte secret</p>
      </App>,
    );
    expect(ready).toContain("texte secret");
    expect(ready).not.toContain('data-screen="connexion"');
    const fallback = html(<App initialPhase={{ name: "ready" }} />);
    // Sans enfant : la bibliothèque ; le compte vit dans Réglages › Compte (P7).
    expect(fallback).toContain(t("library:loading"));
    expect(fallback).not.toContain('data-screen="reglages-compte"');
  });

  it("rend chaque écran 2FA depuis App", () => {
    const screensMfa: { phase: MfaPhase; marker: string }[] = [
      { phase: { name: "loading" }, marker: 'data-screen="loading"' },
      { phase: { name: "connexion-2fa", notice: null }, marker: 'data-screen="connexion-2fa"' },
      { phase: { name: "connexion-code-secours", notice: null }, marker: 'data-screen="connexion-code-secours"' },
      {
        phase: { name: "activation-2fa", notice: null, enrollment: null },
        marker: 'data-screen="activation-2fa"',
      },
      { phase: { name: "codes-secours", codes: [] }, marker: 'data-screen="codes-secours"' },
      { phase: { name: "reconfigurer-2fa", notice: null }, marker: 'data-screen="reconfigurer-2fa"' },
      { phase: { name: "deconnecte" }, marker: 'data-screen="deconnecte"' },
    ];
    for (const screen of screensMfa) {
      const page = html(
        <App initialMfa={screen.phase}>
          <p>texte secret</p>
        </App>,
      );
      expect(page, screen.phase.name).toContain(screen.marker);
      expect(page, screen.phase.name).toContain('class="desk"');
      expect(page, screen.phase.name).not.toContain("texte secret");
      expect(page, screen.phase.name).not.toContain('data-screen="connexion"');
    }
    const ready = html(
      <App initialMfa={{ name: "ready" }}>
        <p>texte secret</p>
      </App>,
    );
    expect(ready).toContain("texte secret");
    expect(ready).not.toContain(t("mfa:challengeTitle"));
  });

  it("branche mfa et account via i18next, sans import direct des anciens catalogues, et le viewport garde la ligne visible", () => {
    const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
    expect(source).toContain("AuthScreens");
    expect(source).toContain('from "./auth-ui/mfa/index.ts"');
    expect(source).toContain('from "./auth-ui/account/index.ts"');
    expect(source).not.toContain("messages.fr.ts");
    const mfaScreen = readFileSync(new URL("./auth-ui/mfa/screens.tsx", import.meta.url), "utf8");
    const accountScreen = readFileSync(new URL("./auth-ui/account/screen.tsx", import.meta.url), "utf8");
    const authScreen = readFileSync(new URL("./auth-ui/screens.tsx", import.meta.url), "utf8");
    const themeToggle = readFileSync(new URL("./theme/ThemeToggle.tsx", import.meta.url), "utf8");
    for (const file of [mfaScreen, accountScreen, authScreen, themeToggle]) {
      expect(file).not.toContain("messages.fr.ts");
      expect(file).toContain("useTranslate(");
      expect(file).toContain("t(");
    }
    const htmlPage = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    expect(htmlPage).toContain('lang="fr"');
    expect(htmlPage).toContain("width=device-width");
    expect(htmlPage).toContain("initial-scale=1");
    expect(htmlPage).toContain("interactive-widget=resizes-content");
    expect(htmlPage).not.toMatch(/https?:\/\//i);
  });
});
