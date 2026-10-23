import { readdirSync, readFileSync } from "node:fs";

import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MfaScreens } from "./MfaScreens.tsx";
import { t } from "../../i18n/i18n.ts";
import { groupSecret, otpauthUri } from "./policy.ts";
import { Activation2faScreen, Connexion2faScreen, ConnexionCodeSecoursScreen, Reconfigurer2faScreen } from "./screens.tsx";

function html(node: ReactNode): string {
  return renderToStaticMarkup(node).replaceAll("&#x27;", "'").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
}

const secret = "A".repeat(32);
const otpauth = otpauthUri(secret, "ada@exemple.fr", t("mfa:issuer")) ?? "";

function recoveryCode(index: number): string {
  const char = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[index] ?? "A";
  const group = char.repeat(4);
  return `${group}-${group}-${group}-${group}`;
}

const codes = Array.from({ length: 10 }, (_, index) => recoveryCode(index));

const password = "phrase-secrete-visible";

describe("écrans D-003 D-005 D-006 D-007", () => {
  it("demande un code à 6 chiffres et le lien vers le code de secours", () => {
    const page = html(
      <MfaScreens
        initialPhase={{ name: "connexion-2fa", notice: null }}
        credentials={{ identifier: "ada@exemple.fr", password, remember: false }}
      >
        <p>texte secret</p>
      </MfaScreens>,
    );
    expect(page).toContain('data-screen="connexion-2fa"');
    expect(page).toContain(t("mfa:challengeTitle"));
    expect(page).toContain(t("mfa:challengeIntro"));
    expect(page).toContain(t("mfa:totpLabel"));
    expect(page).toContain('inputMode="numeric"');
    expect(page).toContain('autoComplete="one-time-code"');
    expect(page).toContain(t("mfa:useRecovery"));
    expect(page).not.toContain(password);
    expect(page).not.toContain("texte secret");
    expect(page).not.toContain("href=");
    expect(page).not.toContain("Fermer");
    expect(page).not.toContain("Désactiver");
  });

  it("décrit le format XXXX-XXXX-XXXX-XXXX", () => {
    const page = html(
      <ConnexionCodeSecoursScreen notice="rejected" pending={false} onSubmit={() => undefined} onBack={() => undefined} />,
    );
    expect(page).toContain('data-screen="connexion-code-secours"');
    expect(page).toContain(t("mfa:recoveryHint"));
    expect(page).toContain("XXXX-XXXX-XXXX-XXXX");
    expect(page).toContain(t("mfa:codeRejected"));
    expect(page).toContain(t("mfa:backToTotp"));
    expect(page).not.toContain("href=");
  });

  it("affiche la clé en clair et un seul lien otpauth, sans image", () => {
    const page = html(
      <Activation2faScreen
        notice={null}
        pending={false}
        secret={secret}
        otpauth={otpauth}
        onSubmit={() => undefined}
        onSignOut={() => undefined}
      />,
    );
    expect(page).toContain('data-screen="activation-2fa"');
    expect(page).toContain(t("mfa:activationTitle"));
    expect(page).toContain(t("mfa:secretLabel"));
    expect(page).toContain(groupSecret(secret));
    expect(page).toContain(`href="${otpauth}"`);
    expect(page).toContain(t("mfa:openApp"));
    expect(page).toContain(t("mfa:signOut"));
    expect(page.match(/href="/g)).toHaveLength(1);
    expect(page).not.toMatch(/<img/i);
    expect(page).not.toMatch(/<canvas/i);
    expect(page).not.toMatch(/<svg/i);
    expect(page).not.toContain(codes[0] ?? "");
    expect(page).not.toContain("Fermer");
    expect(page).not.toContain("Désactiver");
    const forced = html(
      <MfaScreens
        initialPhase={{
          name: "activation-2fa",
          notice: null,
          enrollment: { secret, otpauth, codes },
        }}
      >
        <p>texte secret</p>
      </MfaScreens>,
    );
    expect(forced).toContain(t("mfa:signOut"));
    expect(forced).not.toContain(codes[0] ?? "");
    expect(forced).not.toContain("texte secret");
  });

  it("liste 10 codes et propose copier, enregistrer, imprimer, puis les textes", () => {
    const page = html(
      <MfaScreens initialPhase={{ name: "codes-secours", codes }}>
        <p>texte secret</p>
      </MfaScreens>,
    );
    expect(page).toContain('data-screen="codes-secours"');
    expect(page).toContain(t("mfa:codesIntro"));
    expect(page).toContain("16 caractères");
    expect(page.match(/<li>/g)).toHaveLength(10);
    for (const code of codes) {
      expect(page).toContain(code);
      expect(code).toMatch(/^[A-Z2-7]{4}(?:-[A-Z2-7]{4}){3}$/);
    }
    expect(page).toContain(t("mfa:copy"));
    expect(page).toContain(t("mfa:save"));
    expect(page).toContain(t("mfa:print"));
    expect(page).toContain(t("mfa:continueTexts"));
    expect(page).not.toContain(secret);
    expect(page).not.toContain("texte secret");
    expect(page).not.toContain("Désactiver");
  });

  it("affiche le bandeau de reconfiguration sans ouvrir les textes", () => {
    const page = html(
      <Reconfigurer2faScreen notice={null} pending={true} onReconfigure={() => undefined} onSignOut={() => undefined} />,
    );
    expect(page).toContain('data-screen="reconfigurer-2fa"');
    expect(page).toContain(t("mfa:reconfigureBody"));
    expect(page).toContain("invalidés");
    expect(page).toContain(t("mfa:pending"));
    expect(page).toContain(t("mfa:signOut"));
    expect(page).not.toContain("Fermer");
    const hidden = html(
      <MfaScreens initialPhase={{ name: "reconfigurer-2fa", notice: null }}>
        <p>texte secret</p>
      </MfaScreens>,
    );
    expect(hidden).toContain(t("mfa:reconfigureNow"));
    expect(hidden).not.toContain("texte secret");
    const ready = html(
      <MfaScreens initialPhase={{ name: "ready" }}>
        <p>texte secret</p>
      </MfaScreens>,
    );
    expect(ready).toContain("texte secret");
    expect(ready).not.toContain('data-screen="connexion-2fa"');
  });

  it("montre l'envoi en cours sur le défi", () => {
    const page = html(
      <Connexion2faScreen notice="limited" pending={true} onSubmit={() => undefined} onUseRecovery={() => undefined} />,
    );
    expect(page).toContain(t("mfa:pending"));
    expect(page).toContain(t("mfa:tooMany"));
  });
});

describe("chaînes et périmètre", () => {
  it("garde les libellés de la maquette dans le catalogue", () => {
    expect(t("mfa:useRecovery")).toBe("Utiliser un code de secours");
    expect(t("mfa:openApp")).toBe("Ouvrir l'application");
    expect(t("mfa:continueTexts")).toBe("Accéder à mes textes");
    expect(t("mfa:reconfigureNow")).toBe("Reconfigurer maintenant");
    expect(t("mfa:signOut")).toBe("Se déconnecter");
    expect(t("mfa:copy")).toBe("Copier");
    expect(t("mfa:save")).toBe("Enregistrer");
    expect(t("mfa:print")).toBe("Imprimer");
    expect(t("mfa:issuer")).toBe("Flaw");
  });

  it("n'ajoute ni stockage navigateur, ni inscription, ni dépendance visuelle", () => {
    const files = readdirSync(new URL(".", import.meta.url)).filter(
      (name) => (name.endsWith(".ts") || name.endsWith(".tsx")) && !name.endsWith(".test.ts") && !name.endsWith(".test.tsx"),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const source = readFileSync(new URL(name, import.meta.url), "utf8");
      expect(source, name).not.toContain("localStorage");
      expect(source, name).not.toContain("sessionStorage");
      expect(source, name).not.toContain("indexedDB");
      expect(source, name).not.toContain("document.cookie");
      expect(source, name).not.toContain("dangerouslySetInnerHTML");
      expect(source, name).not.toContain("innerHTML");
      expect(source, name).not.toContain("mailto:");
      expect(source, name).not.toContain("sign-up");
      expect(source, name).not.toContain("qrcode");
      expect(source, name).not.toContain("Désactiver");
      expect(source, name).not.toContain("Fermer");
      expect(source, name).not.toContain("/api/auth/mfa/disable");
      for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
        const spec = match[1] ?? "";
        expect(spec.startsWith(".") || spec === "react", `${name} importe ${spec}`).toBe(true);
      }
    }
  });
});
