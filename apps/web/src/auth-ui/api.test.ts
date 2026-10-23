import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  AUTH_PATHS,
  CSRF_HEADER,
  CSRF_VALUE,
  createAuthClient,
  type AuthClientOptions,
  type AuthResult,
  type FailureKind,
  type FetchLike,
} from "./api.ts";

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

async function failureKindOf(result: Promise<AuthResult<unknown>>): Promise<FailureKind> {
  const value = await result;
  if (value.ok) {
    throw new Error("succès inattendu");
  }
  return value.kind;
}

const profile = {
  id: "user-1",
  email: "ada@exemple.fr",
  role: "user" as const,
  locale: "fr",
  timeZone: "UTC",
  mfaEnrolled: false,
  passwordMustChange: false,
};

describe("client CSRF SEC-WEB-05", () => {
  it("envoie le cookie, JSON et l'en-tête CSRF sur chaque mutation, pas sur GET", async () => {
    const { api, calls } = client(() => jsonResponse(200, { ok: true }), "https://flaw.test");
    await api.signOut();
    await api.fetch("/api/v1/documents/1", { method: "PUT", body: { title: "a" } });
    await api.fetch("/api/v1/documents/1", { method: "PATCH", body: { title: "b" } });
    await api.fetch("/api/v1/documents/1", { method: "DELETE" });
    await api.me();

    const mutations = calls.slice(0, 4);
    for (const call of mutations) {
      expect(call.init.credentials).toBe("include");
      expect(call.init.cache).toBe("no-store");
      expect(call.init.mode).toBe("same-origin");
      expect(header(call.init, "content-type")).toBe("application/json");
      expect(header(call.init, CSRF_HEADER)).toBe(CSRF_VALUE);
      expect(header(call.init, "origin")).toBe("https://flaw.test");
      expect(typeof call.init.body).toBe("string");
      expect(() => JSON.parse(String(call.init.body))).not.toThrow();
    }
    const read = calls[4];
    expect(read?.init.method).toBe("GET");
    expect(read?.init.body).toBeUndefined();
    expect(header(read?.init ?? {}, CSRF_HEADER)).toBeNull();
    expect(header(read?.init ?? {}, "content-type")).toBeNull();
    expect(header(read?.init ?? {}, "accept")).toBe("application/json");
    expect(read?.init.credentials).toBe("include");
  });

  it("ne laisse pas le demandeur retirer le JSON ni l'en-tête CSRF", async () => {
    const { api, calls } = client(() => jsonResponse(200, { ok: true }));
    await api.fetch(AUTH_PATHS.signOut, {
      method: "post",
      headers: { "content-type": "text/plain", [CSRF_HEADER]: "autre" },
    });
    expect(header(calls[0]?.init ?? {}, "content-type")).toBe("application/json");
    expect(header(calls[0]?.init ?? {}, CSRF_HEADER)).toBe(CSRF_VALUE);
    expect(calls[0]?.init.method).toBe("POST");
  });

  it("ne fixe Origin que si l'appelant hors navigateur le demande", async () => {
    const { api, calls } = client(() => jsonResponse(200, { ok: true }));
    await api.signOut();
    expect(header(calls[0]?.init ?? {}, "origin")).toBeNull();
  });
});

describe("appels d'authentification", () => {
  it("normalise l'identifiant, omet remember faux et ne renvoie pas de jeton", async () => {
    const { api, calls } = client(() =>
      jsonResponse(200, { id: "user-1", identifier: "ada@exemple.fr", token: "secret-session" }),
    );
    const result = await api.signIn({
      identifier: "  Ada@Exemple.fr  ",
      password: "e\u0301-phrase-secrete",
      remember: false,
    });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      identifier: "ada@exemple.fr",
      password: "é-phrase-secrete",
    });
    expect(result).toEqual({
      ok: true,
      status: 200,
      data: { id: "user-1", identifier: "ada@exemple.fr" },
    });
  });

  it("envoie remember vrai seulement lorsque la case est cochée", async () => {
    const { api, calls } = client(() => jsonResponse(200, { id: "user-1", identifier: "ada@exemple.fr" }));
    await api.signIn({ identifier: "ada@exemple.fr", password: "phrase-secrete-ok", remember: true });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      identifier: "ada@exemple.fr",
      password: "phrase-secrete-ok",
      remember: true,
    });
  });

  it("distingue identifiants refusés, second facteur, plafond et mot de passe refusé", async () => {
    const unauthorized = client(() => jsonResponse(401, { code: "unauthorized" }));
    expect(
      await failureKindOf(unauthorized.api.signIn({ identifier: "ada@exemple.fr", password: "x", remember: false })),
    ).toBe("unauthorized");

    const mfa = client(() => jsonResponse(401, { code: "unauthorized", detail: "code d'authentification requis" }));
    expect(await failureKindOf(mfa.api.signIn({ identifier: "ada@exemple.fr", password: "x", remember: false }))).toBe(
      "mfa_required",
    );

    const limited = client(() => jsonResponse(429, { code: "too_many_requests" }, { "retry-after": "12" }));
    const limitedResult = await limited.api.signIn({ identifier: "ada@exemple.fr", password: "x", remember: false });
    expect(limitedResult).toMatchObject({ ok: false, kind: "limited", retryAfter: 12 });

    const rejected = client(() => jsonResponse(400, { code: "invalid_request", detail: "mot de passe refusé" }));
    expect(
      await failureKindOf(
        rejected.api.changePassword({ currentPassword: "provisoire-valide", newPassword: "phrase-secrete-ok" }),
      ),
    ).toBe("rejected");
  });

  it("reconnaît le 403 mfa_required de GET /me et ignore les champs secrets", async () => {
    const blocked = client(() => jsonResponse(403, { code: "mfa_required", status: 403 }));
    expect(await failureKindOf(blocked.api.me())).toBe("mfa_required");

    const { api } = client(() => jsonResponse(200, { ...profile, passwordHash: "argon", token: "non" }));
    const result = await api.me();
    expect(result).toEqual({ ok: true, status: 200, data: profile });
  });

  it("refuse un mot de passe trop court sans appel réseau", async () => {
    const { api, calls } = client(() => jsonResponse(200, { ok: true }));
    const result = await api.changePassword({ currentPassword: "provisoire", newPassword: "123456789012" });
    expect(result).toMatchObject({ ok: false, kind: "rejected", status: 400 });
    expect(calls).toHaveLength(0);
  });

  it("demande le mot de passe provisoire sans autre champ", async () => {
    const { api, calls } = client(() =>
      jsonResponse(200, { message: "L'administrateur fournit un mot de passe provisoire (commande serveur)." }),
    );
    const result = await api.forgetPassword(" Ada@Exemple.fr ");
    expect(calls[0]?.path).toBe(AUTH_PATHS.forgetPassword);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ identifier: "ada@exemple.fr" });
    expect(result.ok).toBe(true);
  });

  it("ne contacte pas l'inscription et traduit une panne réseau", async () => {
    expect(Object.values(AUTH_PATHS).join(" ")).not.toContain("sign-up");
    const fetchImpl: FetchLike = () => Promise.reject(new Error("coupure"));
    const api = createAuthClient({ fetch: fetchImpl });
    expect(await api.me()).toMatchObject({ ok: false, kind: "network", status: 0 });
  });
});

describe("stockage local", () => {
  it("ne lit ni n'écrit de jeton dans le stockage du navigateur", () => {
    const source = readFileSync(new URL("./api.ts", import.meta.url), "utf8");
    expect(source).not.toContain("localStorage");
    expect(source).not.toContain("sessionStorage");
    expect(source).not.toContain("indexedDB");
    expect(source).not.toContain("document.cookie");
  });
});
