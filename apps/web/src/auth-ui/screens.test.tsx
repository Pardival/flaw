import { readdirSync, readFileSync } from "node:fs";

import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AuthScreens } from "./AuthScreens.tsx";
import { t } from "../i18n/i18n.ts";
import { PASSWORD_MIN_LENGTH } from "./policy.ts";
import { NouveauMotDePasseScreen } from "./screens.tsx";

function html(node: ReactNode): string {
  return renderToStaticMarkup(node).replaceAll("&#x27;", "'").replaceAll("&quot;", '"');
}

describe("écrans D-001 D-002 D-004 D-042", () => {
  it("présente la connexion avec le minimum de 15 caractères et « Rester connecté »", () => {
    const page = html(
      <AuthScreens initialPhase={{ name: "connexion", notice: null }}>
        <p>texte secret</p>
      </AuthScreens>,
    );
    expect(page).toContain('data-screen="connexion"');
    expect(page).toContain(t("auth:emailLabel"));
    expect(page).toContain(t("auth:passwordLabel"));
    expect(page).toContain(t("auth:passwordHint", { min: PASSWORD_MIN_LENGTH }));
    expect(page).toContain(t("auth:rememberLabel"));
    expect(page).toContain(t("auth:rememberHint"));
    expect(page).toContain(t("auth:forgotAction"));
    expect(page).not.toContain("texte secret");
    expect(page).not.toContain("mailto:");
    expect(page).not.toContain("href=");
  });

  it("explique qu'aucun e-mail n'est envoyé après une erreur d'identifiants", () => {
    const page = html(
      <AuthScreens initialPhase={{ name: "connexion-mdp-oublie", notice: "credential" }}>
        <p>texte secret</p>
      </AuthScreens>,
    );
    expect(page).toContain('data-screen="connexion-mdp-oublie"');
    expect(page).toContain(t("auth:credentialError"));
    expect(page).toContain(t("auth:forgotBody"));
    expect(page).toContain("Aucun e-mail n'est envoyé.");
    expect(page).toContain("mot de passe provisoire (commande serveur)");
    expect(page).not.toMatch(/mailto:/i);
    expect(page).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    expect(page).not.toContain("texte secret");
  });

  it("compte 12 caractères sur 15 minimum", () => {
    const page = html(
      <NouveauMotDePasseScreen
        notice={null}
        pending={false}
        initialNewPassword="123456789012"
        onSubmit={() => undefined}
      />,
    );
    expect(page).toContain('data-screen="nouveau-mot-de-passe"');
    expect(page).toContain(t("auth:newPasswordIntro"));
    expect(t("auth:passwordCounter", { current: 12, min: 15 })).toBe("12 caractères sur 15 minimum");
    expect(page).toContain("12 caractères sur 15 minimum");
    const forced = html(
      <AuthScreens initialPhase={{ name: "nouveau-mot-de-passe", notice: null }}>
        <p>texte secret</p>
      </AuthScreens>,
    );
    expect(forced).toContain("0 caractères sur 15 minimum");
    expect(forced).not.toContain("texte secret");
  });

  it("laisse le brouillon en place sur la reconnexion nécessaire", () => {
    const page = html(
      <AuthScreens initialPhase={{ name: "reconnexion-necessaire", notice: null, forgot: true }}>
        <p>brouillon local</p>
      </AuthScreens>,
    );
    expect(page).toContain('data-screen="reconnexion-necessaire"');
    expect(page).toContain(t("auth:reconnectTitle"));
    expect(page).toContain(t("auth:reconnectBody"));
    expect(page).toContain(t("auth:reconnectAction"));
    expect(page).toContain(t("auth:forgotBody"));
    expect(page).toContain("brouillon local");
  });

  it("cache le texte tant que la session n'est pas prête, puis le montre", () => {
    const hidden = html(
      <AuthScreens initialPhase={{ name: "loading" }}>
        <p>texte secret</p>
      </AuthScreens>,
    );
    expect(hidden).toContain(t("auth:loading"));
    expect(hidden).not.toContain("texte secret");
    const ready = html(
      <AuthScreens initialPhase={{ name: "ready" }}>
        <p>texte secret</p>
      </AuthScreens>,
    );
    expect(ready).toContain("texte secret");
    expect(ready).not.toContain('data-screen="connexion"');
  });
});

describe("chaînes des composants", () => {
  it("garde les phrases dans le catalogue et n'ouvre ni inscription ni e-mail", () => {
    const files = readdirSync(new URL(".", import.meta.url)).filter(
      (name) => name.endsWith(".tsx") && !name.endsWith(".test.tsx"),
    );
    for (const name of files) {
      const source = readFileSync(new URL(name, import.meta.url), "utf8");
      expect(source, name).not.toContain("administrateur");
      expect(source, name).not.toContain("mailto:");
      expect(source, name).not.toContain("sign-up");
      expect(source, name).not.toContain("localStorage");
      expect(source, name).not.toContain("sessionStorage");
      expect(source, name).not.toContain("indexedDB");
      expect(source, name).not.toContain("document.cookie");
      expect(source, name).not.toContain("dangerouslySetInnerHTML");
      expect(source, name).not.toContain("innerHTML");
    }
  });
});
