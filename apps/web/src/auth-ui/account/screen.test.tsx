import { readFileSync, readdirSync } from "node:fs";

import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AuthClient } from "../api.ts";
import { PASSWORD_MIN_LENGTH } from "../policy.ts";
import { AccountSettings } from "./AccountSettings.tsx";
import { parseSessions } from "./account.ts";
import { messages } from "./messages.fr.ts";
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
    expect(page).toContain(messages.title);
    expect(page).toContain(messages.passwordTitle);
    expect(page).toContain(messages.passwordHint(PASSWORD_MIN_LENGTH));
    expect(page).toContain(messages.mfaActive);
    expect(messages.mfaActive).toBe("Activée · Obligatoire");
    expect(page).toContain(messages.changeDevice);
    expect(page).toContain(messages.regenerateCodes);
    expect(page).toContain(messages.devicesTitle);
    expect(page).toContain(messages.deviceType.desktop);
    expect(page).toContain("Firefox");
    expect(page).toContain("Linux");
    expect(page).toContain(messages.deviceType.phone);
    expect(page).toContain("Safari");
    expect(page).toContain("iOS");
    expect(page).toContain("23/10/2026 15:04");
    expect(page).toContain("23/10/2026 12:00");
    expect(page).toContain(messages.thisDevice);
    expect(page).toContain(messages.revokeOthers);
    expect(page).not.toContain("203.0.113.50");
    expect(page).not.toContain("Lyon");
    expect(page).not.toContain("France");
    expect(page).not.toContain("48.8566");
    expect(page).not.toContain("secret-session");
    expect(page).not.toContain(ACTIVITY);
    expect(page).not.toContain("ada@exemple.fr");

    const current = page.slice(page.indexOf(`data-session="${CURRENT}"`), page.indexOf(`data-session="${OTHER}"`));
    expect(current).toContain(messages.thisDevice);
    expect(current).toContain(messages.signOut);
    expect(current).not.toContain(messages.revoke);
    const other = page.slice(page.indexOf(`data-session="${OTHER}"`));
    expect(other).toContain(messages.revoke);
    expect(other).not.toContain(messages.thisDevice);
  });

  it("n'offre pas de désactivation et réserve les actions 2FA à une activation", () => {
    const enrolled = screen();
    expect(enrolled).toContain(messages.mfaActive);
    expect(enrolled.toLowerCase()).not.toContain("désactiv");
    expect(enrolled.toLowerCase()).not.toContain("desactiv");
    const plain = screen({ mfaEnrolled: false });
    expect(plain).toContain(messages.mfaObligatory);
    expect(plain).not.toContain(messages.mfaActive);
    expect(plain).not.toContain(messages.changeDevice);
    expect(plain).not.toContain(messages.regenerateCodes);
    expect(plain.toLowerCase()).not.toContain("désactiv");
  });

  it("compte les caractères du nouveau mot de passe et demande la ré-authentification", () => {
    const page = screen({ initialNewPassword: "123456789012", pending: true });
    expect(page).toContain("12 caractères sur 15 minimum");
    expect(page).toContain(messages.pending);

    const asking = screen({ reauth: true, mfaEnrolled: true });
    expect(asking).toContain(messages.reauthTitle);
    expect(asking).toContain(messages.reauthBody);
    expect(asking).toContain(messages.reauthTotpLabel);
    expect(asking).toContain(messages.rememberLabel);
    expect(asking).toContain(messages.rememberHint);
    expect(asking).toContain('id="account-reauth-totp"');

    const passwordOnly = screen({ reauth: true, mfaEnrolled: false });
    expect(passwordOnly).toContain(messages.reauthBodyPassword);
    expect(passwordOnly).not.toContain('id="account-reauth-totp"');
  });

  it("cache les appareils pendant le chargement, après la déconnexion et sans session", () => {
    const loading = screen({ phase: "loading", sessions: [] });
    expect(loading).toContain(messages.loading);
    expect(loading).not.toContain(messages.thisDevice);
    expect(loading).not.toContain(messages.passwordTitle);
    expect(loading).not.toContain("Firefox");

    const signedOut = screen({ phase: "signed_out" });
    expect(signedOut).toContain(messages.signedOut);
    expect(signedOut).not.toContain("Firefox");

    const blocked = screen({ phase: "blocked", notice: "unauthorized", sessions: [] });
    expect(blocked).toContain(messages.unauthorized);
    expect(blocked).not.toContain('id="account-current-password"');

    const empty = screen({ sessions: [], sessionsKnown: true });
    expect(empty).toContain(messages.emptyDevices);
    const unknown = screen({ sessions: [], sessionsKnown: false, notice: "network" });
    expect(unknown).toContain(messages.network);
    expect(unknown).not.toContain(messages.emptyDevices);
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
    const catalogue = JSON.stringify(messages);
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
    expect(page).toContain(messages.loading);
    expect(page).not.toContain(messages.thisDevice);
    expect(page).not.toContain("Désactiver");
  });
});
