import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  AUTH_PATHS,
  CSRF_HEADER,
  CSRF_VALUE,
  createAuthClient,
  type AuthClient,
  type AuthClientOptions,
  type FetchLike,
} from "../api.ts";
import {
  SESSIONS_PATH,
  activityZone,
  classifySessionStatus,
  disconnectDevice,
  disconnectOthers,
  formatActivity,
  initialAccountState,
  listSessions,
  loadAccount,
  parseSessions,
  reauthAndDisconnectOthers,
  reauthenticate,
  reduceAccount,
  savePassword,
  sessionPath,
  sessionView,
  type AccountSession,
} from "./account.ts";
import { messages } from "./messages.fr.ts";

const CURRENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ACTIVITY = "2026-10-23T15:04:00.000Z";

const profile = {
  id: "user-1",
  email: "ada@exemple.fr",
  role: "user" as const,
  locale: "fr",
  timeZone: "UTC",
  mfaEnrolled: true,
  passwordMustChange: false,
};

function sessionBody(id: string, current: boolean, extra: Record<string, unknown> = {}) {
  return {
    id,
    current,
    deviceType: current ? "desktop" : "phone",
    browser: current ? "Firefox" : "Safari",
    os: current ? "Linux" : "iOS",
    deviceLabel: current ? "Firefox · Linux" : "Safari · iOS",
    createdAt: "2026-10-23T14:00:00.000Z",
    lastSeenAt: ACTIVITY,
    lastActivity: ACTIVITY,
    expiresAt: "2026-11-22T15:04:00.000Z",
    ...extra,
  };
}

function sensitiveExtra() {
  return {
    ip: "203.0.113.50",
    ipAddress: "203.0.113.51",
    city: "Lyon",
    country: "France",
    location: "48.8566,2.3522",
    latitude: 48.85,
    longitude: 2.35,
    token: "secret-session",
    userAgent: "Mozilla/5.0",
  };
}

type Call = { path: string; init: RequestInit };

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function recorded(handler: (call: Call) => Response): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = (path, init) => {
    const call = { path, init: init ?? {} };
    calls.push(call);
    return Promise.resolve(handler(call));
  };
  return { fetch, calls };
}

function client(handler: (call: Call) => Response, origin?: string) {
  const captured = recorded(handler);
  const options: AuthClientOptions = { fetch: captured.fetch, ...(origin === undefined ? {} : { origin }) };
  return { api: createAuthClient(options), calls: captured.calls };
}

function header(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name);
}

function stub(fetchImpl: AuthClient["fetch"], extra: Partial<AuthClient> = {}): AuthClient {
  const unexpected = (): Promise<never> => Promise.reject(new Error("appel inattendu"));
  return {
    fetch: fetchImpl,
    signIn: extra.signIn ?? unexpected,
    signOut: extra.signOut ?? unexpected,
    forgetPassword: extra.forgetPassword ?? unexpected,
    changePassword: extra.changePassword ?? unexpected,
    me: extra.me ?? unexpected,
  };
}

describe("liste des appareils", () => {
  it("retient le type, le navigateur, le système et la dernière activité", () => {
    const sessions = parseSessions([
      sessionBody(CURRENT, true, sensitiveExtra()),
      sessionBody(OTHER, false),
    ]);
    expect(sessions).toHaveLength(2);
    const current = sessions?.[0];
    expect(current).toEqual({
      id: CURRENT,
      current: true,
      deviceType: "desktop",
      browser: "Firefox",
      os: "Linux",
      lastActivity: ACTIVITY,
    });
    expect(JSON.stringify(sessions)).not.toContain("203.0.113");
    expect(JSON.stringify(sessions)).not.toContain("Lyon");
    expect(JSON.stringify(sessions)).not.toContain("France");
    expect(JSON.stringify(sessions)).not.toContain("secret-session");
    expect(JSON.stringify(sessions)).not.toContain("48.8566");
    expect(formatActivity(ACTIVITY, "UTC")).toBe("23/10/2026 15:04");
    expect(sessionView(current as AccountSession, "UTC")).toEqual({
      id: CURRENT,
      current: true,
      typeLabel: messages.deviceType.desktop,
      browser: "Firefox",
      os: "Linux",
      lastActivity: "23/10/2026 15:04",
    });
    expect(sessionView(current as AccountSession, "Asia/Ho_Chi_Minh").lastActivity).toBe("23/10/2026 22:04");
  });

  it("reconstruit navigateur et système depuis l'étiquette et ignore une adresse", () => {
    const sessions = parseSessions([
      {
        id: OTHER,
        current: false,
        deviceLabel: "Firefox · macOS",
        lastSeenAt: ACTIVITY,
        createdAt: ACTIVITY,
        expiresAt: ACTIVITY,
      },
      {
        id: CURRENT,
        current: true,
        browser: "203.0.113.9",
        os: "48.8566,2.3522",
        lastActivity: ACTIVITY,
        lastSeenAt: ACTIVITY,
      },
    ]);
    expect(sessions?.[0]).toMatchObject({ browser: "Firefox", os: "macOS", deviceType: null });
    expect(sessions?.[1]).toMatchObject({ browser: messages.unknownValue, os: messages.unknownValue });
    expect(sessionView(sessions?.[1] as AccountSession, "UTC").typeLabel).toBe(messages.deviceType.unknown);
  });

  it("écarte un identifiant qui n'est pas un uuid et un corps qui n'est pas une liste", () => {
    expect(parseSessions({ devices: [] })).toBeNull();
    const sessions = parseSessions([
      { id: "../admin", current: false, browser: "Firefox", os: "Linux", lastActivity: ACTIVITY },
      sessionBody(OTHER, false),
    ]);
    expect(sessions?.map((item) => item.id)).toEqual([OTHER]);
    expect(sessionPath(`${OTHER}/../admin`)).toBeNull();
    expect(sessionPath(OTHER)).toBe(`${SESSIONS_PATH}/${OTHER}`);
    expect(activityZone("Pas/UneZone")).toBe("UTC");
    expect(formatActivity("demain", "UTC")).toBeNull();
  });
});

describe("appels de session", () => {
  it("lit GET sans CSRF et révoque avec JSON et l'en-tête CSRF", async () => {
    const { api, calls } = client((call) => {
      if (call.init.method === "GET") {
        return jsonResponse(200, [sessionBody(CURRENT, true)]);
      }
      return new Response(null, { status: 204 });
    }, "https://flaw.test");

    const listed = await listSessions(api);
    expect(listed).toMatchObject({ ok: true });
    await api.fetch(`${SESSIONS_PATH}/${OTHER}`, { method: "DELETE" });
    await disconnectOthers(api);

    const read = calls[0];
    expect(read?.path).toBe(SESSIONS_PATH);
    expect(read?.init.method).toBe("GET");
    expect(read?.init.body).toBeUndefined();
    expect(header(read?.init ?? {}, CSRF_HEADER)).toBeNull();
    expect(read?.init.credentials).toBe("include");

    const removal = calls[1];
    expect(removal?.init.method).toBe("DELETE");
    expect(header(removal?.init ?? {}, CSRF_HEADER)).toBe(CSRF_VALUE);
    expect(header(removal?.init ?? {}, "content-type")).toBe("application/json");
    expect(header(removal?.init ?? {}, "origin")).toBe("https://flaw.test");
    expect(removal?.init.body).toBe("{}");

    const others = calls[2];
    expect(others?.path).toBe(SESSIONS_PATH);
    expect(others?.init.method).toBe("DELETE");
    expect(calls[3]?.path).toBe(SESSIONS_PATH);
    expect(calls[3]?.init.method).toBe("GET");
  });

  it("demande une ré-authentification sur 403 reauth_required et confond 404", async () => {
    const reauth = client(() =>
      jsonResponse(403, {
        type: "https://flaw.example.com/problems/reauth_required",
        status: 403,
        title: "Ré-authentification requise",
        code: "reauth_required",
      }),
    );
    expect(await disconnectOthers(reauth.api)).toEqual({ ok: false, kind: "reauth" });
    expect(reauth.calls).toHaveLength(1);

    const missing = client((call) => {
      if (call.init.method === "DELETE") {
        return jsonResponse(404, { code: "not_found", status: 404 });
      }
      return jsonResponse(200, [sessionBody(CURRENT, true)]);
    });
    const gone = await disconnectDevice(missing.api, {
      id: OTHER,
      current: false,
      deviceType: "phone",
      browser: "Safari",
      os: "iOS",
      lastActivity: ACTIVITY,
    });
    expect(gone).toMatchObject({ ok: false, kind: "not_found" });
    expect(missing.calls[1]?.init.method).toBe("GET");

    expect(classifySessionStatus(403, { code: "mfa_required" })).toBe("mfa");
    expect(classifySessionStatus(403, { detail: "origine refusée" })).toBe("forbidden");
    expect(classifySessionStatus(401, { code: "unauthorized" })).toBe("unauthorized");
  });

  it("déconnecte cet appareil par la sortie de session, pas par un chemin forgé", async () => {
    let signedOut = 0;
    const fetchImpl: AuthClient["fetch"] = () => {
      throw new Error("réseau");
    };
    const api = stub(fetchImpl, {
      signOut: () => {
        signedOut += 1;
        return Promise.resolve({ ok: true, status: 200, data: { ok: true } });
      },
    });
    const result = await disconnectDevice(api, {
      id: CURRENT,
      current: true,
      deviceType: "desktop",
      browser: "Firefox",
      os: "Linux",
      lastActivity: ACTIVITY,
    });
    expect(result).toEqual({ ok: true, signedOut: true });
    expect(signedOut).toBe(1);

    const forged = stub(fetchImpl);
    const rejected = await disconnectDevice(forged, {
      id: "../api",
      current: false,
      deviceType: null,
      browser: "Firefox",
      os: "Linux",
      lastActivity: ACTIVITY,
    });
    expect(rejected).toEqual({ ok: false, kind: "invalid" });
  });

  it("ré-authentifie par une nouvelle connexion puis révoque, sans rendre le jeton", async () => {
    const { api, calls } = client((call) => {
      if (call.path === AUTH_PATHS.signIn) {
        return jsonResponse(200, { id: "user-1", identifier: "ada@exemple.fr", token: "secret-session" });
      }
      if (call.init.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return jsonResponse(200, [sessionBody(CURRENT, true)]);
    });
    const early = await reauthenticate(api, {
      identifier: "ada@exemple.fr",
      password: "phrase",
      totp: "12",
      totpRequired: true,
      remember: false,
    });
    expect(early).toEqual({ ok: false, kind: "invalid" });
    expect(calls).toHaveLength(0);

    const result = await reauthenticate(api, {
      identifier: "  Ada@Exemple.fr  ",
      password: "e\u0301-phrase",
      totp: "123456",
      totpRequired: true,
      remember: true,
    });
    expect(result).toEqual({ ok: true });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      identifier: "ada@exemple.fr",
      password: "é-phrase",
      totp: "123456",
      remember: true,
    });
    expect(header(calls[0]?.init ?? {}, CSRF_HEADER)).toBe(CSRF_VALUE);

    const omitted = client(() => jsonResponse(200, { id: "user-1", identifier: "ada@exemple.fr" }));
    await reauthenticate(omitted.api, {
      identifier: "ada@exemple.fr",
      password: "phrase-secrete",
      totp: "123456",
      totpRequired: false,
      remember: false,
    });
    expect(JSON.parse(String(omitted.calls[0]?.init.body))).toEqual({
      identifier: "ada@exemple.fr",
      password: "phrase-secrete",
    });

    const refused = client(() => jsonResponse(401, { code: "unauthorized" }));
    expect(
      await reauthenticate(refused.api, {
        identifier: "ada@exemple.fr",
        password: "mauvais",
        totp: "123456",
        totpRequired: true,
        remember: false,
      }),
    ).toEqual({ ok: false, kind: "reauth_failed" });

    const chained = client((call) => {
      if (call.path === AUTH_PATHS.signIn) {
        return jsonResponse(200, { id: "user-1", identifier: "ada@exemple.fr", token: "secret-session" });
      }
      if (call.init.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return jsonResponse(200, [sessionBody(CURRENT, true)]);
    });
    const revoked = await reauthAndDisconnectOthers(chained.api, {
      identifier: "ada@exemple.fr",
      password: "phrase-secrete",
      totp: "654321",
      totpRequired: true,
      remember: false,
    });
    expect(revoked).toMatchObject({ ok: true });
    expect(JSON.stringify(revoked)).not.toContain("secret-session");
    expect(chained.calls.map((call) => `${call.init.method} ${call.path}`)).toEqual([
      `POST ${AUTH_PATHS.signIn}`,
      `DELETE ${SESSIONS_PATH}`,
      `GET ${SESSIONS_PATH}`,
    ]);
  });

  it("charge le profil puis les sessions, et enregistre le mot de passe avant de relire", async () => {
    const loaded = client((call) => {
      if (call.path === AUTH_PATHS.me) {
        return jsonResponse(200, { ...profile, passwordHash: "argon", token: "non" });
      }
      return jsonResponse(200, [sessionBody(CURRENT, true, sensitiveExtra())]);
    });
    const account = await loadAccount(loaded.api);
    expect(account.notice).toBeNull();
    expect(account.profile).toEqual({ email: "ada@exemple.fr", mfaEnrolled: true, timeZone: "UTC" });
    expect(JSON.stringify(account.sessions)).not.toContain("argon");
    expect(JSON.stringify(account.sessions)).not.toContain("203.0.113");
    expect(loaded.calls.map((call) => call.path)).toEqual([AUTH_PATHS.me, SESSIONS_PATH]);

    const blocked = client(() => jsonResponse(403, { code: "mfa_required", status: 403 }));
    expect(await loadAccount(blocked.api)).toMatchObject({ profile: null, notice: "mfa", sessions: [] });

    const saved = client((call) => {
      if (call.path === AUTH_PATHS.changePassword) {
        return jsonResponse(200, { ok: true });
      }
      return jsonResponse(200, [sessionBody(CURRENT, true)]);
    });
    const password = await savePassword(saved.api, {
      currentPassword: "phrase-actuelle-ok",
      newPassword: "phrase-nouvelle-ok",
    });
    expect(password).toMatchObject({ ok: true, sessions: [expect.objectContaining({ id: CURRENT, current: true })] });
    expect(saved.calls[0]?.path).toBe(AUTH_PATHS.changePassword);
    expect(saved.calls[1]?.path).toBe(SESSIONS_PATH);

    const wrong = client(() => jsonResponse(401, { code: "unauthorized" }));
    expect(
      await savePassword(wrong.api, { currentPassword: "non", newPassword: "phrase-nouvelle-ok" }),
    ).toEqual({ ok: false, kind: "current_password" });
    expect(wrong.calls).toHaveLength(1);
  });
});

describe("transitions", () => {
  it("passe de la liste à la ré-authentification, puis masque les appareils sans session", () => {
    const ready = reduceAccount(initialAccountState, {
      type: "loaded",
      blocked: false,
      mfaEnrolled: true,
      timeZone: "Pas/UneZone",
      sessions: [
        {
          id: CURRENT,
          current: true,
          deviceType: "desktop",
          browser: "Firefox",
          os: "Linux",
          lastActivity: ACTIVITY,
        },
      ],
      notice: null,
    });
    expect(ready.phase).toBe("ready");
    expect(ready.timeZone).toBe("UTC");
    expect(ready.sessionsKnown).toBe(true);
    expect(ready.mfaEnrolled).toBe(true);

    const asking = reduceAccount(ready, { type: "need_reauth" });
    expect(asking.reauth).toBe(true);
    expect(asking.notice).toBe("reauth");
    expect(asking.sessions).toHaveLength(1);

    const gone = reduceAccount(asking, { type: "notice", notice: "unauthorized" });
    expect(gone.phase).toBe("blocked");
    expect(gone.sessions).toEqual([]);
    expect(gone.reauth).toBe(false);

    const out = reduceAccount(ready, { type: "signed_out" });
    expect(out.phase).toBe("signed_out");
    expect(out.sessions).toEqual([]);
  });
});

describe("périmètre", () => {
  it("ne stocke rien dans le navigateur et n'évoque pas une notification de connexion", () => {
    const names = readdirSync(new URL(".", import.meta.url)).filter(
      (name) => (name.endsWith(".ts") || name.endsWith(".tsx")) && !name.includes(".test."),
    );
    for (const name of names) {
      const source = readFileSync(new URL(name, import.meta.url), "utf8");
      expect(source, name).not.toContain("localStorage");
      expect(source, name).not.toContain("sessionStorage");
      expect(source, name).not.toContain("indexedDB");
      expect(source, name).not.toContain("document.cookie");
      expect(source, name).not.toContain("new_login");
      expect(source, name).not.toContain("innerHTML");
      expect(source, name).not.toContain("dangerouslySetInnerHTML");
      expect(source, name).not.toContain("/api/auth/sessions");
      expect(source, name).not.toContain("auth-ui/mfa");
    }
  });
});
