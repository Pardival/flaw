/**
 * Liste blanche de la session restreinte, mesurée sur tout l'OpenAPI (A-012).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import type { AppConfig } from "../config/load.ts";
import { FORGOT_MESSAGE, LOGIN_HTML } from "./html.ts";
import { AUTH_ROUTES } from "./routes.ts";
import { openApiOperations, RESTRICTED_ALLOW, RESTRICTED_TTL_MS, restrictedDecision } from "./restricted-session.ts";

const ORIGIN = "https://flaw.test";
const openapi = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../../openapi.json", import.meta.url)), "utf8"),
) as { paths?: Record<string, unknown> };

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    NODE_ENV: "test",
    LOG_LEVEL: "info",
    logLevel: "info",
    PORT: 3000,
    PUBLIC_URL: ORIGIN,
    TRUSTED_ORIGINS: ORIGIN,
    TRUSTED_PROXY_CIDR: "",
    DATABASE_HOST: "127.0.0.1",
    DATABASE_NAME: "flaw",
    DATABASE_USER: "flaw_app",
    FLAW_KEK_ID: "kek-2026-10",
    RECOVERY_PEPPER_ID: "pep-2026-10",
    RECOVERY_PEPPER_OLD_IDS: "",
    HMAC_PEPPER_ID: "pep-hmac-2026-10",
    ALLOW_SIGNUP: "false",
    allowSignup: false,
    FLAW_AUTH_BEARER_ENABLED: "false",
    bearerEnabled: false,
    SESSION_IDLE_DAYS: 30,
    SESSION_MAX_DAYS: 90,
    SESSION_REVALIDATE_SECONDS: 30,
    MAX_DOCUMENT_SIZE_MB: 10,
    MAX_WS_MESSAGE_MB: 10,
    EXPORT_TIMEOUT_SECONDS: 60,
    EXPORT_MAX_CONCURRENCY: 1,
    EXPORT_MAX_RSS_MB: 900,
    PASSWORD_MIN_LENGTH: 15,
    SNAPSHOT_RETENTION_DAYS: 30,
    ALERT_WEBHOOK_URL: "",
    bodyLimit: 10 * 1024 * 1024,
    ...overrides,
  };
}

describe("session restreinte et OpenAPI", () => {
  it("dure 15 minutes et classe chaque opération publiée (A-012)", () => {
    expect(RESTRICTED_TTL_MS).toBe(15 * 60 * 1000);
    const operations = openApiOperations(openapi).map((op) => `${op.method} ${op.path}`).sort();
    expect(operations).toEqual([
      "DELETE /api/v1/documents/{id}",
      "GET /api/v1/documents",
      "GET /api/v1/healthz",
      "GET /api/v1/me",
    ]);
    for (const op of openApiOperations(openapi)) {
      const isPublic = op.method === "GET" && op.path === "/api/v1/healthz";
      expect(restrictedDecision(op.method, op.path, isPublic)).toBe(isPublic ? "public" : "deny");
    }
    expect(RESTRICTED_ALLOW).toEqual([
      "POST /api/auth/change-password",
      "POST /api/auth/sign-out",
      "POST /api/auth/mfa/enroll",
      "POST /api/auth/mfa/verify",
    ]);
  });

  it("n'expose aucune route publique de désactivation MFA (AC-064)", () => {
    expect(AUTH_ROUTES.some((route) => route.url.includes("mfa/disable"))).toBe(false);
    expect(LOGIN_HTML.toLowerCase()).not.toContain("désactiver");
    expect(LOGIN_HTML.toLowerCase()).not.toContain("mailto:");
    expect(FORGOT_MESSAGE.toLowerCase()).not.toContain("mailto:");
    expect(FORGOT_MESSAGE).not.toMatch(/@/);
  });

  it("laisse l'inscription en 404 même si ALLOW_SIGNUP est true (SEC-AUTH-03)", async () => {
    const app = buildApp(config({ ALLOW_SIGNUP: "true", allowSignup: true }));
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up",
      headers: { "content-type": "application/json", origin: ORIGIN },
      payload: JSON.stringify({ identifier: "a@box.invalid", password: "phrase-secrete-longue" }),
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
