import { readFileSync, readdirSync } from "node:fs";

import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { account } from "../../i18n/fr/account.ts";
import { t } from "../../i18n/i18n.ts";
import type { AuthClient } from "../api.ts";
import { PASSWORD_MIN_LENGTH } from "../policy.ts";
import { AccountSettings } from "./AccountSettings.tsx";
import { parseSessions } from "./account.ts";
import { AccountSettingsScreen, type AccountSettingsScreenProps } from "./screen.tsx";

const CURRENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ACTIVITY = "2026-10-23T15:04:00.000Z";

function html(node: ReactNode): string {
  return renderToStaticMarkup(node).replaceAll("&#x27;", "'").replaceAll("&quot;", '"');
}

function screen(overrides: Partial<AccountSettingsScreenProps> = {}): string {
  const sessions = parseSessions([
    {
      id: CURRENT,
      current: true,
      deviceType: "desktop",
      browser: "Firefox",
      os: "Linux",
      createdAt: "2026-10-23T14:00:00.000Z",
      lastSeenAt: ACTIVITY,
      lastActivity: ACTIVITY,
      expiresAt: "2026-11-22T15:04:00.000Z",
      ip: "203.0.113.50",
      city: "Lyon",
      country: "France",
      location: "48.8566,2.3522",
      token: "secret-session",
    },
    {
      id: OTHER,
      current: false,
      deviceType: "phone",
      browser: "Safari",
      os: "iOS",
      deviceLabel: "Safari · iOS",
      createdAt: "2026-10-22T12:00:00.000Z",
      lastSeenAt: "2026-10-23T12:00:00.000Z",
      lastActivity: "2026-10-23T12:00:00.000Z",
      expiresAt: "2026-11-22T12:00:00.000Z",
    },
  ]);
  expect(sessions).not.toBeNull();
  const props: AccountSettingsScreenProps = {
    phase: "ready",
    pending: false,
    mfaEnrolled: true,
    timeZone: "UTC",
    sessions: sessions ?? [],
    sessionsKnown: true,
    notice: null,
    reauth: false,
    onChangePassword: () => undefined,
    onRevoke: () => undefined,
    onSignOut: () => undefined,
    onRevokeOthers: () => undefined,
    onReauth: () => undefined,
    onChangeDevice: () => undefined,
    onRegenerateCodes: () => undefined,
    ...overrides,
  };
  return html(<AccountSettingsScreen {...props} />);
}

describe("écran D-008", () => {
  it("affiche type, navigateur, système, dernière activité et « Cet appareil »", () => {
    const page = screen();
    expect(page).toContain('data-screen="reglages-compte"');
    expect(page).toContain(t("account:title"));
    expect(page).toContain(t("account:passwordTitle"));
    expect(page).toContain(t("account:passwordHint", { min: PASSWORD_MIN_LENGTH }));
    expect(page).toContain(t("account:mfaActive"));
    expect(t("account:mfaActive")).toBe("Activée · Obligatoire");
    expect(page).toContain(t("account:changeDevice"));
    expect(page).toContain(t("account:regenerateCodes"));
    expect(page).toContain(t("account:devicesTitle"));
    expect(page).toContain(t("account:deviceType.desktop"));
    expect(page).toContain("Firefox");
    expect(page).toContain("Linux");
    expect(page).toContain(t("account:deviceType.phone"));
    expect(page).toContain("Safari");
    expect(page).toContain("iOS");
    expect(page).toContain("23/10/2026 15:04");
    expect(page).toContain("23/10/2026 12:00");
    expect(page).toContain(t("account:thisDevice"));
    expect(page).toContain(t("account:revokeOthers"));
    expect(page).not.toContain("203.0.113.50");
    expect(page).not.toContain("Lyon");
    expect(page).not.toContain("France");
    expect(page).not.toContain("48.8566");
    expect(page).not.toContain("secret-session");
    expect(page).not.toContain(ACTIVITY);
    expect(page).not.toContain("ada@exemple.fr");

    const current = page.slice(page.indexOf(`data-session="${CURRENT}"`), page.indexOf(`data-session="${OTHER}"`));
    expect(current).toContain(t("account:thisDevice"));
    expect(current).toContain(t("account:signOut"));
    expect(current).not.toContain(t("account:revoke"));
    const other = page.slice(page.indexOf(`data-session="${OTHER}"`));
    expect(other).toContain(t("account:revoke"));
    expect(other).not.toContain(t("account:thisDevice"));
  });

  it("n'offre pas de désactivation et réserve les actions 2FA à une activation", () => {
    const enrolled = screen();
    expect(enrolled).toContain(t("account:mfaActive"));
    expect(enrolled.toLowerCase()).not.toContain("désactiv");
    expect(enrolled.toLowerCase()).not.toContain("desactiv");
    const plain = screen({ mfaEnrolled: false });
    expect(plain).toContain(t("account:mfaObligatory"));
    expect(plain).not.toContain(t("account:mfaActive"));
    expect(plain).not.toContain(t("account:changeDevice"));
    expect(plain).not.toContain(t("account:regenerateCodes"));
    expect(plain.toLowerCase()).not.toContain("désactiv");
  });

  it("compte les caractères du nouveau mot de passe et demande la ré-authentification", () => {
    const page = screen({ initialNewPassword: "123456789012", pending: true });
    expect(page).toContain("12 caractères sur 15 minimum");
    expect(page).toContain(t("account:pending"));

    const asking = screen({ reauth: true, mfaEnrolled: true });
    expect(asking).toContain(t("account:reauthTitle"));
    expect(asking).toContain(t("account:reauthBody"));
    expect(asking).toContain(t("account:reauthTotpLabel"));
    expect(asking).toContain(t("account:rememberLabel"));
    expect(asking).toContain(t("account:rememberHint"));
    expect(asking).toContain('id="account-reauth-totp"');

    const passwordOnly = screen({ reauth: true, mfaEnrolled: false });
    expect(passwordOnly).toContain(t("account:reauthBodyPassword"));
    expect(passwordOnly).not.toContain('id="account-reauth-totp"');
  });

  it("cache les appareils pendant le chargement, après la déconnexion et sans session", () => {
    const loading = screen({ phase: "loading", sessions: [] });
    expect(loading).toContain(t("account:loading"));
    expect(loading).not.toContain(t("account:thisDevice"));
    expect(loading).not.toContain(t("account:passwordTitle"));
    expect(loading).not.toContain("Firefox");

    const signedOut = screen({ phase: "signed_out" });
    expect(signedOut).toContain(t("account:signedOut"));
    expect(signedOut).not.toContain("Firefox");

    const blocked = screen({ phase: "blocked", notice: "unauthorized", sessions: [] });
    expect(blocked).toContain(t("account:unauthorized"));
    expect(blocked).not.toContain('id="account-current-password"');

    const empty = screen({ sessions: [], sessionsKnown: true });
    expect(empty).toContain(t("account:emptyDevices"));
    const unknown = screen({ sessions: [], sessionsKnown: false, notice: "network" });
    expect(unknown).toContain(t("account:network"));
    expect(unknown).not.toContain(t("account:emptyDevices"));
  });

  it("n'écrit pas les phrases ni les adresses dans les composants", () => {
    const files = readdirSync(new URL(".", import.meta.url)).filter((name) => name.endsWith(".tsx") && !name.endsWith(".test.tsx"));
    for (const name of files) {
      const source = readFileSync(new URL(name, import.meta.url), "utf8");
      expect(source, name).not.toContain("Désactiver");
      expect(source, name).not.toContain("mailto:");
      expect(source, name).not.toContain("href=");
      expect(source, name).not.toContain("localStorage");
      expect(source, name).not.toContain("innerHTML");
      expect(source, name).not.toContain("new_login");
    }
    const view = readFileSync(new URL("./screen.tsx", import.meta.url), "utf8");
    expect(view).not.toContain("fetch(");
    expect(view).not.toContain("/api/");
    expect(view).not.toContain("email");
    const catalogue = JSON.stringify(account);
    expect(catalogue.toLowerCase()).not.toContain("désactiv");
    expect(catalogue).not.toContain("new_login");
    expect(catalogue).not.toContain("Lyon");
    expect(catalogue).not.toContain("GeoIP");
  });
});

describe("conteneur", () => {
  it("reste sur le chargement tant que l'effet n'a pas tourné", () => {
    const pending = new Promise<Response>(() => undefined);
    const client: AuthClient = {
      fetch: () => pending,
      signIn: () => pending.then(() => ({ ok: false, status: 0, kind: "network", retryAfter: null })),
      signOut: () => pending.then(() => ({ ok: false, status: 0, kind: "network", retryAfter: null })),
      forgetPassword: () => pending.then(() => ({ ok: false, status: 0, kind: "network", retryAfter: null })),
      changePassword: () => pending.then(() => ({ ok: false, status: 0, kind: "network", retryAfter: null })),
      me: () => pending.then(() => ({ ok: false, status: 0, kind: "network", retryAfter: null })),
    };
    const page = html(<AccountSettings client={client} />);
    expect(page).toContain(t("account:loading"));
    expect(page).not.toContain(t("account:thisDevice"));
    expect(page).not.toContain("Désactiver");
  });
});
