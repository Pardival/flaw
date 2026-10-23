import { describe, expect, it } from "vitest";

import {
  AUTH_PATHS,
  CSRF_HEADER,
  CSRF_VALUE,
  createAuthClient,
  type AuthClientOptions,
  type Credentials,
  type FetchLike,
} from "../api.ts";

import {
  enrollmentAccount,
  enrollFresh,
  enrollOnce,
  MFA_PATHS,
  signOutOfEnrollment,
  submitRecoveryCode,
  submitTotpCode,
  verifyEnrollmentCode,
} from "./flow.ts";
import { t } from "../../i18n/i18n.ts";

type Call = { path: string; init: RequestInit };

const credentials: Credentials = {
  identifier: "  Ada@Exemple.fr  ",
  password: "e\u0301-phrase-secrete",
  remember: false,
};

const secret = "A".repeat(32);

function recoveryCode(index: number): string {
  const char = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[index] ?? "A";
  const group = char.repeat(4);
  return `${group}-${group}-${group}-${group}`;
}

const codes = Array.from({ length: 10 }, (_, index) => recoveryCode(index));

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function client(handler: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetch: FetchLike = (path, init) => {
    const call = { path, init: init ?? {} };
    calls.push(call);
    return Promise.resolve(handler(call));
  };
  const options: AuthClientOptions = { fetch };
  return { api: createAuthClient(options), calls };
}

function header(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name);
}

function bodyOf(call: Call | undefined): Record<string, unknown> {
  return JSON.parse(String(call?.init.body)) as Record<string, unknown>;
}

describe("second facteur sur le client existant", () => {
  it("renvoie le TOTP avec le mot de passe, sans code de secours ni jeton", async () => {
    const { api, calls } = client(() => jsonResponse(200, { id: "user-1", identifier: "ada@exemple.fr", token: "secret-session" }));
    const result = await submitTotpCode(api, credentials, " 123 456 ");
    expect(result).toEqual({ ok: true });
    expect(calls[0]?.path).toBe(AUTH_PATHS.signIn);
    expect(bodyOf(calls[0])).toEqual({
      identifier: "ada@exemple.fr",
      password: "é-phrase-secrete",
      totp: "123456",
    });
    expect(bodyOf(calls[0])).not.toHaveProperty("recoveryCode");
    expect(bodyOf(calls[0])).not.toHaveProperty("token");
    expect(header(calls[0]?.init ?? {}, CSRF_HEADER)).toBe(CSRF_VALUE);
    expect(header(calls[0]?.init ?? {}, "content-type")).toBe("application/json");
    expect(calls[0]?.init.credentials).toBe("include");
  });

  it("envoie remember et le code de secours, jamais les deux facteurs", async () => {
    const { api, calls } = client(() => jsonResponse(200, { id: "user-1", identifier: "ada@exemple.fr" }));
    const result = await submitRecoveryCode(api, { ...credentials, remember: true }, "aaaa aaaa aaaa aaaa");
    expect(result).toEqual({ ok: true });
    expect(bodyOf(calls[0])).toEqual({
      identifier: "ada@exemple.fr",
      password: "é-phrase-secrete",
      remember: true,
      recoveryCode: "AAAA-AAAA-AAAA-AAAA",
    });
    expect(bodyOf(calls[0])).not.toHaveProperty("totp");
  });

  it("ne contacte pas le serveur si le code ou la session locale est inutilisable", async () => {
    const { api, calls } = client(() => jsonResponse(200, { id: "user-1", identifier: "ada@exemple.fr" }));
    const malformedRecovery = "AAAA-AAAA-AAAA-AAA0";
    expect(await submitTotpCode(api, credentials, "12345")).toEqual({ ok: false, notice: "format" });
    expect(await submitRecoveryCode(api, credentials, malformedRecovery)).toEqual({ ok: false, notice: "format" });
    expect(await submitTotpCode(api, undefined, "123456")).toEqual({ ok: false, notice: "invalid" });
    expect(await submitTotpCode(api, { ...credentials, password: "" }, "123456")).toEqual({ ok: false, notice: "invalid" });
    expect(calls).toHaveLength(0);
  });

  it("distingue code refusé, second facteur encore exigé, plafond et réseau", async () => {
    const rejected = client(() => jsonResponse(401, { code: "unauthorized" }));
    expect(await submitTotpCode(rejected.api, credentials, "123456")).toEqual({ ok: false, notice: "rejected" });

    const required = client(() => jsonResponse(401, { code: "unauthorized", detail: "code d'authentification requis" }));
    expect(await submitTotpCode(required.api, credentials, "123456")).toEqual({ ok: false, notice: "required" });

    const limited = client(() => jsonResponse(429, { code: "too_many_requests" }, { "retry-after": "12" }));
    const recovery = "AAAA-AAAA-AAAA-AAAA";
    expect(await submitRecoveryCode(limited.api, credentials, recovery)).toEqual({ ok: false, notice: "limited" });

    const fetchImpl: FetchLike = () => Promise.reject(new Error("coupure"));
    const offline = createAuthClient({ fetch: fetchImpl });
    expect(await submitTotpCode(offline, credentials, "123456")).toEqual({ ok: false, notice: "network" });
  });
});

describe("enrôlement et vérification", () => {
  it("demande la clé une seule fois et construit le lien otpauth", async () => {
    const { api, calls } = client(() => jsonResponse(200, { secret, codes, extra: "non" }));
    const first = await enrollOnce(api, "ada@exemple.fr", t("mfa:issuer"));
    const second = await enrollOnce(api, "ada@exemple.fr", t("mfa:issuer"));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe(MFA_PATHS.enroll);
    expect(bodyOf(calls[0])).toEqual({});
    expect(header(calls[0]?.init ?? {}, CSRF_HEADER)).toBe(CSRF_VALUE);
    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    if (!first.ok) {
      throw new Error("enrôlement attendu");
    }
    expect(first.enrollment.secret).toBe(secret);
    expect(first.enrollment.codes).toEqual(codes);
    expect(first.enrollment.otpauth.startsWith("otpauth://totp/")).toBe(true);
    expect(first.enrollment.otpauth).toContain(`secret=${secret}`);
    expect(first.enrollment.otpauth).not.toMatch(/https?:\/\//);
    expect(JSON.stringify(first.enrollment)).not.toContain("extra");
  });

  it("relance un enrôlement refusé, puis un appel frais pour reconfigurer", async () => {
    let failed = true;
    const { api, calls } = client(() =>
      failed
        ? jsonResponse(403, { code: "forbidden", detail: "enrôlement refusé" })
        : jsonResponse(200, { secret, codes }),
    );
    expect(await enrollOnce(api, "ada@exemple.fr", t("mfa:issuer"))).toEqual({ ok: false, notice: "forbidden" });
    failed = false;
    const again = await enrollOnce(api, "ada@exemple.fr", t("mfa:issuer"));
    expect(again.ok).toBe(true);
    const fresh = await enrollFresh(api, "ada@exemple.fr", t("mfa:issuer"));
    expect(fresh.ok).toBe(true);
    expect(calls.map((call) => call.path)).toEqual([MFA_PATHS.enroll, MFA_PATHS.enroll, MFA_PATHS.enroll]);
  });

  it("refuse une réponse qui n'a pas 10 codes distincts", async () => {
    const { api, calls } = client(() => jsonResponse(200, { secret, codes: codes.slice(0, 9) }));
    expect(await enrollFresh(api, "ada@exemple.fr", t("mfa:issuer"))).toEqual({ ok: false, notice: "server" });
    expect(calls).toHaveLength(1);
  });

  it("vérifie le code à 6 chiffres sur /api/auth/mfa/verify", async () => {
    const { api, calls } = client((call) => {
      if (call.path === MFA_PATHS.enroll) {
        return jsonResponse(200, { secret, codes });
      }
      return jsonResponse(200, { ok: true });
    });
    expect(await verifyEnrollmentCode(api, "12")).toEqual({ ok: false, notice: "format" });
    expect(calls).toHaveLength(0);
    const enrolled = await enrollOnce(api, "ada@exemple.fr", t("mfa:issuer"));
    expect(enrolled.ok).toBe(true);
    expect(await verifyEnrollmentCode(api, "654321")).toEqual({ ok: true });
    expect(calls[1]?.path).toBe(MFA_PATHS.verify);
    expect(bodyOf(calls[1])).toEqual({ code: "654321" });
    expect(bodyOf(calls[1])).not.toHaveProperty("secret");
    const after = await enrollOnce(api, "ada@exemple.fr", t("mfa:issuer"));
    expect(after.ok).toBe(true);
    expect(calls.filter((call) => call.path === MFA_PATHS.enroll)).toHaveLength(2);
  });

  it("déconnecte par le client partagé", async () => {
    const { api, calls } = client(() => jsonResponse(200, { ok: true }));
    expect(await signOutOfEnrollment(api)).toEqual({ ok: true });
    expect(calls[0]?.path).toBe(AUTH_PATHS.signOut);
    expect(header(calls[0]?.init ?? {}, CSRF_HEADER)).toBe(CSRF_VALUE);
  });

  it("choisit le libellé du compte sans garder un identifiant vide", () => {
    expect(enrollmentAccount(undefined, credentials, t("mfa:accountFallback"))).toBe("ada@exemple.fr");
    expect(enrollmentAccount("  Bureau  ", credentials, t("mfa:accountFallback"))).toBe("Bureau");
    expect(enrollmentAccount("  ", undefined, t("mfa:accountFallback"))).toBe(t("mfa:accountFallback"));
  });
});
