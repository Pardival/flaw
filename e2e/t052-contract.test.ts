/**
 * T-052 — alignement du contrat 0.4.18 : cookie, 401, /me, configuration, Semgrep.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { buildApp } from "../apps/server/src/app.ts";
import { DEVICE_COOKIE, serializeDeviceCookie, serializeSessionCookie, SESSION_COOKIE } from "../apps/server/src/auth/cookie.ts";
import { BAD_REQUEST, MFA_REQUIRED, ORIGIN_REJECTED } from "../apps/server/src/auth/html.ts";
import { allowedOrigins } from "../apps/server/src/auth/routes.ts";
import type { AppConfig } from "../apps/server/src/config/load.ts";
import { readPublicEnv } from "../apps/server/src/config/env.ts";
import { buildOpenApiDocument, meResponseSchema } from "../apps/server/src/platform/openapi.ts";
import { problem } from "../apps/server/src/platform/problem.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const ORIGIN = "https://flaw.test";
const LEGACY_SESSION_COOKIE = "__Secure-flaw.session_token";

function config(): AppConfig {
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
  };
}

function walk(directory: string, found: string[]): void {
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules" || entry === ".git" || entry === "dist" || entry === "coverage") {
      continue;
    }
    const path = join(directory, entry);
    const info = statSync(path);
    if (info.isDirectory()) {
      walk(path, found);
      continue;
    }
    found.push(path);
  }
}

describe("T-052 contrat", () => {
  it("pose __Host-flaw_session Secure, Path=/ , sans Domain", () => {
    const header = serializeSessionCookie("jeton", 3600);
    expect(SESSION_COOKIE).toBe("__Host-flaw_session");
    expect(header.startsWith(`${SESSION_COOKIE}=jeton`)).toBe(true);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Path=/");
    expect(header).not.toMatch(/;\s*Domain=/i);
    expect(header.split(";").some((part) => part.trim().toLowerCase().startsWith("domain="))).toBe(false);
  });

  it("pose __Host-flaw_device Secure, Path=/, sans Domain", () => {
    const header = serializeDeviceCookie("secret-appareil");
    expect(DEVICE_COOKIE).toBe("__Host-flaw_device");
    expect(header.startsWith(`${DEVICE_COOKIE}=secret-appareil`)).toBe(true);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Strict");
    expect(header).toContain("Path=/");
    expect(header).not.toMatch(/;\s*Domain=/i);
    expect(header.split(";").some((part) => part.trim().toLowerCase().startsWith("domain="))).toBe(false);
  });

  it("répond 400, 401 et 403 d'auth en problem+json", async () => {
    const app = buildApp(config());
    const missing = await app.inject({ method: "GET", url: "/api/v1/me" });
    expect(missing.statusCode).toBe(401);
    expect(missing.headers["content-type"]).toContain("application/problem+json");
    expect(missing.headers["cache-control"]).toBe("no-store");
    expect(missing.json()).toEqual(problem(401));
    expect(missing.json()).not.toHaveProperty("message");

    const legacy = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: `${LEGACY_SESSION_COOKIE}=jeton-opaque` },
    });
    expect(legacy.statusCode).toBe(401);
    expect(legacy.headers["content-type"]).toContain("application/problem+json");
    expect(legacy.json()).toEqual(problem(401));

    const named = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: `${SESSION_COOKIE}=jeton-opaque` },
    });
    expect(named.statusCode).toBe(500);

    const rejected = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in",
      headers: { "content-type": "application/json" },
      payload: "{}",
    });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.headers["content-type"]).toContain("application/problem+json");
    expect(rejected.json()).toEqual(problem(403, ORIGIN_REJECTED));
    expect(rejected.json()).not.toHaveProperty("message");

    const routes = readFileSync(join(root, "apps/server/src/auth/routes.ts"), "utf8");
    expect(routes).toContain("sendMessage(reply, 400, BAD_REQUEST)");
    expect(routes).toContain("sendMessage(reply, 401, MFA_REQUIRED)");
    expect(routes).toContain("sendMessage(reply, 429, TOO_MANY");
    expect(routes).toContain("return sendProblem(reply, status, message)");
    expect(routes).not.toContain("application/json; charset=utf-8");
    expect(routes).not.toContain(".send({ message })");
    expect(BAD_REQUEST).toBe("requête invalide");
    expect(MFA_REQUIRED).toBe("code d'authentification requis");
    await app.close();
  });

  it("tue la mutation du 401 not-found vers {message}", async () => {
    const source = readFileSync(join(root, "apps/server/src/app.ts"), "utf8");
    const start = source.indexOf("app.setNotFoundHandler");
    const handler = source.slice(start, source.indexOf('app.get("/api/v1/healthz"', start));
    expect(handler).toContain("sendProblem(reply, 401)");
    expect(handler).not.toContain("{ message");
    expect(handler).not.toContain("AUTH_REQUIRED");
    const app = buildApp(config());
    const missing = await app.inject({ method: "GET", url: "/api/v1/n-existe-pas" });
    expect(missing.statusCode).toBe(401);
    expect(missing.headers["content-type"]).toContain("application/problem+json");
    expect(missing.json()).toEqual(problem(401));
    expect(missing.json()).not.toHaveProperty("message");
    await app.close();
  });

  it("ne lit plus BETTER_AUTH_URL et tolère encore les noms de secrets", () => {
    const parsed = readPublicEnv({
      NODE_ENV: "test",
      PUBLIC_URL: ORIGIN,
      BETTER_AUTH_URL: "pas-une-url",
    });
    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty("BETTER_AUTH_URL");
    const origins = allowedOrigins({
      ...config(),
      BETTER_AUTH_URL: "https://auth.example",
    } as AppConfig);
    expect([...origins].sort()).toEqual([ORIGIN]);
    for (const relative of [
      "apps/server/src/config/env.ts",
      "apps/server/src/config/load.ts",
      "apps/server/src/auth/routes.ts",
    ]) {
      expect(readFileSync(join(root, relative), "utf8")).not.toContain("BETTER_AUTH_URL");
    }
    const secrets = readFileSync(join(root, "apps/server/src/config/secrets.ts"), "utf8");
    expect(secrets).toContain("BETTER_AUTH_SECRET_FILE");
    expect(secrets).toContain("better_auth_secret");
  });

  it("décrit /me selon User et healthz sans clientIp", () => {
    const user = {
      id: "00000000-0000-4000-8000-000000000001",
      email: "a@box.invalid",
      role: "user" as const,
      locale: "fr",
      timeZone: "UTC",
      mfaEnrolled: false,
      passwordMustChange: true,
    };
    expect(meResponseSchema.safeParse(user).success).toBe(true);
    expect(meResponseSchema.safeParse({ ...user, identifier: "a@box.invalid" }).success).toBe(false);
    const document = buildOpenApiDocument();
    const health = JSON.stringify(
      (document.paths as { "/api/v1/healthz": unknown })["/api/v1/healthz"],
    );
    expect(health).not.toContain("clientIp");
    expect(health).not.toContain("version");
    const me = (
      document.paths as {
        "/api/v1/me": { get: { operationId: string; responses: Record<string, { content?: Record<string, { schema?: { required?: string[] } }> }> } };
      }
    )["/api/v1/me"].get;
    expect(me.operationId).toBe("getMe");
    const contract = JSON.parse(
      readFileSync(join(root, "apps/server/openapi/api-contract-0.4.18-derive-t052.json"), "utf8"),
    ) as {
      "x-source": { ref: string; version: string; hash: string; arc_sum: string };
      "x-ecarts-connus": string[];
      "x-bearer": string;
      paths: { "/me": { get: { responses: Record<string, unknown> } }; "/healthz": unknown };
      components: {
        schemas: { User: { required?: string[] }; Problem: unknown };
        responses: { Unauthorized: unknown };
        headers: { CacheControlNoStore: unknown };
        securitySchemes: { sessionCookie: { name: string }; bearerAuth: unknown };
      };
    };
    const userSchema = contract.components.schemas.User;
    expect([...(userSchema.required ?? [])].sort()).toEqual([
      "email",
      "id",
      "locale",
      "mfaEnrolled",
      "passwordMustChange",
      "role",
      "timeZone",
    ]);
    const responses = me.responses as Record<string, { headers?: Record<string, unknown>; content?: unknown; $ref?: string }>;
    expect(responses["200"]?.headers?.["Cache-Control"]).toEqual({
      $ref: "#/components/headers/CacheControlNoStore",
    });
    expect(responses["401"]).toEqual({ $ref: "#/components/responses/Unauthorized" });
    expect(responses["403"]).toBeUndefined();
    expect(contract["x-source"]).toEqual({
      ref: "ARC-API",
      version: "0.4.0-draft",
      hash: "e782cb759b20",
      arc_sum: "322da9f66ea0",
    });
    expect(contract["x-ecarts-connus"]).toEqual(["403 mfa_required → T-009"]);
    expect(contract["x-bearer"]).toBe("implémenté");
    expect(JSON.stringify(contract.paths["/healthz"])).not.toContain("clientIp");
    const expected = structuredClone(contract.paths["/me"].get);
    delete expected.responses["403"];
    expect(me).toEqual(expected);
    expect(contract.paths["/me"].get.responses["403"]).toBeDefined();
    const components = document.components as {
      schemas: { User: unknown; Problem: unknown };
      responses: { Unauthorized: unknown };
      headers: { CacheControlNoStore: unknown };
      securitySchemes: { sessionCookie: { name: string }; bearerAuth: unknown };
    };
    expect(components.schemas.User).toEqual(contract.components.schemas.User);
    expect(components.schemas.Problem).toEqual(contract.components.schemas.Problem);
    expect(components.responses.Unauthorized).toEqual(contract.components.responses.Unauthorized);
    expect(components.headers.CacheControlNoStore).toEqual(contract.components.headers.CacheControlNoStore);
    expect(components.securitySchemes.bearerAuth).toEqual(contract.components.securitySchemes.bearerAuth);
    expect(components.securitySchemes.sessionCookie).toEqual({
      ...contract.components.securitySchemes.sessionCookie,
      name: "__Host-flaw_session",
    });
    expect(contract.components.securitySchemes.sessionCookie.name).toBe("__Secure-flaw.session_token");
    const alternatives = [{ sessionCookie: [] }, { bearerAuth: [] }];
    const paths = document.paths as Record<string, Record<string, { security?: unknown }>>;
    expect(paths["/api/v1/me"]?.get?.security).toEqual(alternatives);
    expect(paths["/api/v1/documents"]?.get?.security).toEqual(alternatives);
    expect(paths["/api/v1/documents/{id}"]?.delete?.security).toEqual(alternatives);
    expect(paths["/api/v1/healthz"]?.get?.security).toEqual([]);
  });

  it("étend la règle Semgrep aux mutations de verifications", () => {
    const source = readFileSync(join(root, ".github/semgrep/auth-tables.yml"), "utf8");
    const line = source.split("\n").find((entry) => entry.includes("pattern-regex:"));
    expect(line).toBeDefined();
    const body = (line ?? "").replace(/^.*pattern-regex:\s*/, "").replace(/^\(\?i\)/, "");
    const regex = new RegExp(body, "i");
    expect(regex.test('await db.query("DELETE FROM flaw.verifications WHERE identifier = $1")')).toBe(true);
    expect(regex.test('await db.query("UPDATE verifications SET identifier = $1")')).toBe(true);
    expect(regex.test('import { verifications } from "../db/schema"')).toBe(true);
    expect(regex.test("const n = 1")).toBe(false);
    expect(source).toContain("**/apps/server/src/auth/**");
  });

  it("ne laisse l'ancien nom de cookie que dans le test de refus", () => {
    const allowed = new Set([
      join(root, "apps/server/src/auth/auth.test.ts"),
      join(root, "e2e/t052-contract.test.ts"),
      join(root, "apps/server/openapi/api-contract-0.4.18-derive-t052.json"),
      join(root, "openapi.json"),
    ]);
    const files: string[] = [];
    walk(root, files);
    const hits = files.filter((path) => readFileSync(path, "utf8").includes(LEGACY_SESSION_COOKIE));
    expect(hits.sort()).toEqual([...allowed].sort());
  });

  it("compare oasdiff au contrat 0.4.18 sans fichier d'exceptions", () => {
    const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toContain("apps/server/openapi/api-contract-0.4.18-derive-t052.json");
    expect(ci).toContain('base.paths["/me"].get');
    const command = ci.split("\n").find((line) => line.includes("breaking --fail-on ERR"));
    expect(command).toContain("/tmp/oas-base-me.json /tmp/oas-rev-me.json");
    expect(command).not.toContain("ignore");
    expect(ci).not.toContain("git show FETCH_HEAD:openapi.json");
  });
});
