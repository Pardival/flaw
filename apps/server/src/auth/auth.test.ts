/**
 * T-007 — AC-030, AC-031, AC-032, AC-033, AC-097, AC-101, AC-102
 * et SEC-AUTH-01, 02, 04, 05, 10, SEC-SESS-01 à 04, SEC-WEB-05, SEC-API-01.
 * Postgres 18.6 épinglé, même image que T-005.
 */
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { assertAppPool, buildApp, declaredRoutes, notifyStartupRefusal } from "../app.ts";
import { loadConfig, type AppConfig } from "../config/load.ts";
import type { LoadedSecrets } from "../config/secrets.ts";
import { applyMigrations, assertAppRole } from "../db/migrate.ts";
import { decodeValidatedKey } from "../crypto/kek.ts";
import { validateKeyMaterial } from "../platform/healthz.ts";
import { mfaRequiredProblem, problem, reauthRequiredProblem } from "../platform/problem.ts";
import { checkRoles } from "../admin/check-roles.ts";
import { DEVICE_COOKIE, hashSessionToken, serializeSessionCookie, SESSION_COOKIE } from "./cookie.ts";
import { issueDeviceSecret, summarizeDevice } from "./device.ts";
import { bucketHmac, hmacKey, subjectHmac, tempHmac } from "./hmac.ts";
import { recoveryCode, recoveryCodeHmac } from "./mfa.ts";
import {
  FORGOT_MESSAGE,
  LOGIN_HTML,
  MFA_REQUIRED,
  RESTRICTED,
  ORIGIN_REJECTED,
  PASSWORD_REJECTED,
  TOO_MANY,
} from "./html.ts";
import {
  ARGON_FLOOR,
  ARGON_TARGET,
  PASSWORD_MIN_FLOOR,
  assessPassword,
  hashPassword,
  verifyPassword,
} from "./password.ts";
import * as passwordModule from "./password.ts";
import { AUTH_ROUTES, isPublicRoute } from "./routes.ts";
import { openAuth } from "./service.ts";
import { insertLock, insertRecoveryCode, listAuditEvents, LOCK_STAGE_ANCHOR, purgeRateLimits } from "./store.ts";

const POSTGRES_IMAGE =
  "postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873";
const DB_PASSWORD = "0123456789abcdef0123456789abcdef";
const HEX = "0123456789abcdef0123456789abcdef";
const ORIGIN = "https://flaw.test";
const PASSWORD = "phrase-secrete-ok";
const TRACKERS = ["google-analytics", "googletagmanager", "segment.io", "plausible.io", "doubleclick.net"];
const root = fileURLToPath(new URL("../../../../", import.meta.url));

function mfaRequiredFromContract(): ReturnType<typeof mfaRequiredProblem> {
  const contract = JSON.parse(
    readFileSync(join(root, "apps/server/openapi/api-contract-0.4.18-derive-t052.json"), "utf8"),
  ) as {
    components: {
      responses: {
        MfaRequired: {
          description: string;
          content: { "application/problem+json": { schema: { $ref: string } } };
        };
      };
      schemas: { Problem: { properties: { type: { format: string }; status: { type: string } } } };
    };
  };
  const response = contract.components.responses.MfaRequired;
  expect(response.content["application/problem+json"].schema.$ref).toBe("#/components/schemas/Problem");
  expect(response.description).toContain("mfa_required");
  expect(contract.components.schemas.Problem.properties.type.format).toBe("uri");
  const body = mfaRequiredProblem();
  expect(body.code).toBe("mfa_required");
  expect(body.type.endsWith("/mfa_required")).toBe(true);
  expect(body.status).toBe(403);
  expect(problem(403, RESTRICTED)).not.toEqual(body);
  return body;
}
const dbTestsLabel = basename(fileURLToPath(import.meta.url));
const cliPath = fileURLToPath(new URL("../admin/cli.ts", import.meta.url));
const container = `flaw-t007-auth-${process.pid}`;

const clock = { ms: Date.parse("2026-01-15T00:00:00.000Z") };
let dbTests = 0;
let ipN = 0;
let userN = 0;

function nextIp(): string {
  ipN += 1;
  const third = 10 + Math.floor(ipN / 200);
  const fourth = (ipN % 200) + 1;
  return `198.51.${third}.${fourth}`;
}

function nextEmail(): string {
  userN += 1;
  return `u${userN}@box.invalid`;
}

function now(): Date {
  return new Date(clock.ms);
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  }
  return sorted[mid] ?? 0;
}

function validKey(): string {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const encoded = randomBytes(32).toString("base64");
    if (validateKeyMaterial(`${encoded}\n`) === null) {
      return encoded;
    }
  }
  throw new Error("aucune clé de test");
}

function docker(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    NODE_ENV: "test",
    LOG_LEVEL: "info",
    logLevel: "info",
    PORT: 3000,
    PUBLIC_URL: ORIGIN,
    TRUSTED_ORIGINS: ORIGIN,
    TRUSTED_PROXY_CIDR: "172.31.250.10/32",
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

function executableSql(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .toLowerCase();
}

function setCookie(headers: Record<string, unknown>): string {
  const raw = headers["set-cookie"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("set-cookie absent");
  }
  return value;
}

function cookiePair(header: string): string {
  return header.split(";")[0] ?? "";
}

function tokenOf(header: string): string {
  const pair = cookiePair(header);
  const eq = pair.indexOf("=");
  return pair.slice(eq + 1);
}

function routeUrl(url: string): string {
  return url.replace(/:[A-Za-z0-9_]+/g, "00000000-0000-4000-8000-000000000001");
}

const LOCATION_KEYS = new Set(["ip", "location", "country", "city"]);

function containsIp(value: string): boolean {
  if (/(?:^|[^0-9])(?:\d{1,3}\.){3}\d{1,3}(?=$|[^0-9])/.test(value)) {
    return true;
  }
  for (const token of value.split(/[^0-9a-f:.]+/i)) {
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(token)) {
      return true;
    }
    if (/^[0-9a-f:]+$/i.test(token) && (token.includes("::") || /^(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}$/i.test(token))) {
      return true;
    }
  }
  return false;
}

function assertNoLocation(value: unknown): void {
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) {
        walk(entry);
      }
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const [key, entry] of Object.entries(node)) {
        expect(LOCATION_KEYS.has(key.toLowerCase()), key).toBe(false);
        walk(entry);
      }
      return;
    }
    if (typeof node === "string") {
      expect(containsIp(node), node).toBe(false);
    }
  };
  walk(value);
}

describe("politique et fichiers (hors base)", () => {
  it("refuse PASSWORD_MIN_LENGTH=6 et garde le plancher 8 (SEC-AUTH-02)", () => {
    const loaded = loadConfig({ PASSWORD_MIN_LENGTH: "6" });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.message).toContain("configuration invalide");
    }
    expect(() => buildApp(config({ PASSWORD_MIN_LENGTH: 6 }))).toThrow(/politique de mot de passe/);
    expect(PASSWORD_MIN_FLOOR).toBe(8);
    expect(ARGON_FLOOR).toEqual({ m: 19456, t: 2, p: 1 });
    expect(ARGON_TARGET).toEqual({ m: 65536, t: 3, p: 1 });
  });

  it("produit deux hachages argon2id distincts et refuse un mot de passe hors politique (SEC-AUTH-01, SEC-AUTH-02)", async () => {
    const first = await hashPassword(PASSWORD, ARGON_FLOOR);
    const second = await hashPassword(PASSWORD, ARGON_FLOOR);
    expect(first).not.toBe(second);
    expect(first.startsWith("$argon2id$v=19$m=19456,t=2,p=1")).toBe(true);
    expect(await verifyPassword(PASSWORD, first)).toBe(true);
    expect(assessPassword("a".repeat(14), 15).ok).toBe(false);
    expect(assessPassword("password", 8).ok).toBe(false);
    expect(assessPassword("a".repeat(129), 15).ok).toBe(false);
    expect(assessPassword("a".repeat(128), 15).ok).toBe(true);
    const emoji = `${"a".repeat(60)}${"😀".repeat(4)}`;
    expect(Array.from(emoji).length).toBe(64);
    expect(assessPassword(emoji, 15).ok).toBe(true);
    const combining = "e\u0301".repeat(15);
    const decision = assessPassword(combining, 15);
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.password).toBe("é".repeat(15));
      const hashed = await hashPassword(decision.password, ARGON_FLOOR);
      expect(await verifyPassword(decision.password, hashed)).toBe(true);
    }
  });

  it("pose autocomplete et n'embarque aucun traceur (SEC-AUTH-02, AC-102)", () => {
    expect(LOGIN_HTML).toContain('autocomplete="username"');
    expect(LOGIN_HTML).toContain('autocomplete="current-password"');
    expect(LOGIN_HTML).toContain('method="post"');
    expect(LOGIN_HTML).toContain('action="/api/auth/sign-in"');
    expect(LOGIN_HTML).not.toContain("Nouveau mot de passe");
    expect(LOGIN_HTML).not.toContain("new-password");
    expect(LOGIN_HTML.toLowerCase()).not.toContain("onpaste");
    expect(LOGIN_HTML).not.toContain("localStorage");
    expect(LOGIN_HTML).not.toContain("sessionStorage");
    const authDir = join(root, "apps/server/src/auth");
    const files = readdirSync(authDir).filter((name) => name.endsWith(".ts") && name !== "auth.test.ts");
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const source = readFileSync(join(authDir, name), "utf8");
      for (const host of TRACKERS) {
        expect(source).not.toContain(host);
      }
    }
    const device = JSON.stringify(summarizeDevice("Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Firefox/128.0"));
    expect(device).not.toContain("country");
    expect(device).not.toContain("city");
    expect(summarizeDevice("Mozilla/5.0 (Windows NT 10.0) Edg/120.0")).toEqual({ browser: "Edge", os: "Windows" });
    expect(summarizeDevice("Mozilla/5.0 (Linux; Android 14) Chrome/120.0")).toEqual({ browser: "Chrome", os: "Android" });
    expect(summarizeDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/605")).toEqual({
      browser: "Safari",
      os: "iOS",
    });
    const cookie = serializeSessionCookie("jeton", null);
    expect(cookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
    expect(SESSION_COOKIE).toBe("__Host-flaw_session");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain("Domain=");
    expect(cookie).not.toContain("Max-Age");
    expect(serializeSessionCookie("jeton", 90)).toContain("Max-Age=90");
  });

  it("documente la conversion key_id des contenus et ne réécrit pas 0000 (0002, 0004)", () => {
    const init = readFileSync(join(root, "apps/server/drizzle/0000_init.sql"), "utf8");
    const authSql = readFileSync(join(root, "apps/server/drizzle/0004_auth.sql"), "utf8");
    const dek = readFileSync(join(root, "apps/server/drizzle/0002_dek_audit.sql"), "utf8");
    expect(init).toContain("token_hash text NOT NULL");
    expect(authSql).toContain("password_hash");
    expect(authSql).toContain("TYPE bytea");
    expect(authSql.toLowerCase()).not.toContain("country");
    expect(authSql.toLowerCase()).not.toContain("latitude");
    expect(dek).toContain("USING key_id::uuid");
    expect(dek.toLowerCase()).toContain("rien n'est déployé");
    expect(dek.toLowerCase()).toContain("kek-2026-10");
    const executable = executableSql(dek);
    expect(executable).toContain("alter table flaw.documents alter column key_id type uuid using key_id::uuid");
    expect(executable).not.toContain("alter table flaw.user_keys alter column key_id type uuid");
    const dockerfile = readFileSync(join(root, "apps/server/Dockerfile"), "utf8");
    expect(dockerfile).toContain("/usr/local/bin/flaw-admin");
  });

  it("dérive la clé HMAC des identifiants selon le vecteur T-006", () => {
    const pepper = Buffer.from("0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20", "hex").toString(
      "base64",
    );
    const key = hmacKey(pepper, "pep-hmac-vecteur-1");
    expect(key.toString("hex")).toBe("a87a5ab0e5693726ea63e40cb65826db845c362178654c196ea8ad6a953ff201");
  });

  it("calcule le hachage leurre dès l'ouverture", async () => {
    const auth = openAuth({
      pool: {} as Pool,
      pepper: validKey(),
      pepperId: "pep-hmac-2026-10",
      minLength: 15,
      idleDays: 30,
      maxDays: 90,
      argon: ARGON_FLOOR,
      now: () => new Date(),
    });
    const first = auth.ready();
    expect(auth.ready()).toBe(first);
    await first;
  });

  it("exige une session sur chaque route hors liste blanche (SEC-API-01)", async () => {
    const app = buildApp(config());
    app.get("/api/v1/nouvelle", async () => ({ ok: true }));
    const routes = declaredRoutes(app);
    expect(routes.length).toBeGreaterThan(0);
    expect(routes.some((route) => route.method === "GET" && route.url === "/api/v1/nouvelle")).toBe(true);
    for (const route of routes) {
      const url = routeUrl(route.url);
      const response = await app.inject({
        method: route.method as "GET",
        url,
        headers: route.method === "GET" || route.method === "HEAD" ? {} : { origin: ORIGIN },
      });
      if (isPublicRoute(route.method, route.url)) {
        expect(response.statusCode, `${route.method} ${route.url}`).not.toBe(401);
      } else {
        expect(response.statusCode, `${route.method} ${route.url}`).toBe(401);
        if (route.method !== "HEAD") {
          expect(response.headers["content-type"], `${route.method} ${route.url}`).toContain("application/problem+json");
          expect(response.json(), `${route.method} ${route.url}`).toEqual(problem(401));
        }
      }
    }
    await app.close();
  });

  it("exige une session sur les routes protégées et laisse la santé sans version (SEC-API-01, AC-030)", async () => {
    const app = buildApp(config());
    const health = await app.inject({ method: "GET", url: "/api/v1/healthz" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ok" });
    expect(health.body).not.toContain("clientIp");
    expect(health.body).not.toContain("version");
    const login = await app.inject({ method: "GET", url: "/login" });
    expect(login.statusCode).toBe(200);
    expect(login.body).toContain("Mot de passe oublié");
    const signup = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up",
      headers: { "content-type": "application/json", origin: ORIGIN },
      payload: "{}",
    });
    expect(signup.statusCode).toBe(404);
    for (const route of AUTH_ROUTES) {
      if (!route.auth) {
        continue;
      }
      const url = routeUrl(route.url);
      const response = await app.inject({
        method: route.method,
        url,
        headers: { "content-type": "application/json", origin: ORIGIN },
        payload: route.method === "GET" ? undefined : "{}",
      });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(401);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.json()).toEqual(problem(401));
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    await app.close();
  });

  it("n'expose pas de route WebSocket (f7, SEC-AUTH-06)", () => {
    const serverRoot = join(root, "apps/server/src");
    const files: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        // La synchro WSS (API-024, T-019) est la seule route WebSocket, et vit dans sync/.
        if (entry.isDirectory() && entry.name !== "sync") {
          walk(path);
          continue;
        }
        if (entry.isDirectory()) {
          continue;
        }
        if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
          files.push(path);
        }
      }
    };
    walk(serverRoot);
    const source = files.map((path) => readFileSync(path, "utf8")).join("\n");
    expect(source).not.toMatch(/@fastify\/websocket|new WebSocket|websocket\(/);
  });

  it("refuse Token et TOKEN, y compris sur la santé et une route inconnue", async () => {
    const app = buildApp(config());
    for (const url of [
      "/api/v1/healthz?Token=x",
      "/api/v1/healthz?TOKEN=x",
      "/api/v1/absent?Token=x",
      "/api/v1/absent?TOKEN=x",
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(401);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.json()).toEqual(problem(401));
    }
    await app.close();
  });
});

describe("authentification sur PostgreSQL", () => {
  let owner: Client;
  let appClient: Client;
  let pool: Pool;
  let port = 0;
  let secretDir = "";
  let pepper = "";
  const stream = new PassThrough();
  let logText = "";
  stream.on("data", (chunk: Buffer) => {
    logText += chunk.toString("utf8");
  });

  const secrets = {
    databasePassword: DB_PASSWORD,
    betterAuthSecret: HEX,
    kek: "",
    recoveryPepper: "",
    hmacPepper: "",
  } as LoadedSecrets;

  function logMark(): number {
    return logText.length;
  }

  function appOptions(argon: { m: number; t: number; p: number } = ARGON_FLOOR) {
    return {
      pool,
      secrets,
      argon,
      now,
      logStream: stream,
    };
  }

  const devices = new Map<string, string>();

  async function sign(
    app: ReturnType<typeof buildApp>,
    identifier: string,
    password: string,
    ip: string,
    remember?: boolean,
    headers: Record<string, string> = {},
  ) {
    const device = devices.get(identifier);
    const extraCookie = headers.cookie;
    const deviceCookie =
      device !== undefined && (extraCookie === undefined || !extraCookie.includes(`${DEVICE_COOKIE}=`))
        ? `${DEVICE_COOKIE}=${device}`
        : undefined;
    const cookie =
      extraCookie !== undefined && deviceCookie !== undefined
        ? `${extraCookie}; ${deviceCookie}`
        : (extraCookie ?? deviceCookie);
    const rest = { ...headers };
    delete rest.cookie;
    return app.inject({
      method: "POST",
      url: "/api/auth/sign-in",
      remoteAddress: "172.31.250.10",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        "x-real-ip": ip,
        ...rest,
        ...(cookie === undefined ? {} : { cookie }),
      },
      payload: JSON.stringify({
        identifier,
        password,
        ...(remember === undefined ? {} : { remember }),
      }),
    });
  }

  async function seedUser(email: string, password: string, params = ARGON_FLOOR): Promise<string> {
    const passwordHash = await hashPassword(password, params);
    const inserted = await pool.query<{ id: string }>("INSERT INTO flaw.users (role) VALUES ('user') RETURNING id");
    const id = inserted.rows[0]?.id;
    if (id === undefined) {
      throw new Error("utilisateur absent");
    }
    await pool.query(
      "INSERT INTO flaw.accounts (owner_id, provider_id, account_id, password_hash) VALUES ($1, 'credential', $2, $3)",
      [id, email, passwordHash],
    );
    const dekId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO flaw.user_keys (id, owner_id, wrapped_ct, wrapped_nonce, key_id, enc_version, status)
       VALUES ($1, $2, $3, $4, 'kek-2026-10', 1, 'active')`,
      [dekId, id, Buffer.from([1]), Buffer.from([2])],
    );
    await pool.query(
      `INSERT INTO flaw.auth_factors (id, owner_id, kind, secret_ct, secret_nonce, key_id, enc_version)
       VALUES ($1, $2, 'totp', $3, $4, $5, 1)`,
      [crypto.randomUUID(), id, Buffer.from([1]), Buffer.from([2]), dekId],
    );
    const mac = hmacKey(pepper, "pep-hmac-2026-10");
    const far = new Date(clock.ms + 10 * 365 * 24 * 60 * 60 * 1000);
    await pool.query(
      "INSERT INTO flaw.verifications (identifier, value_hash, expires_at) VALUES ($1, '1', $2)",
      [bucketHmac(mac, `totp-confirmed|${id}`), far],
    );
    const issued = issueDeviceSecret();
    await pool.query(
      "INSERT INTO flaw.verifications (identifier, value_hash, expires_at) VALUES ($1, $2, $3)",
      [issued.hash, id, far],
    );
    devices.set(email, issued.token);
    return id;
  }

  async function seedDocument(ownerId: string): Promise<string> {
    const id = crypto.randomUUID();
    const existing = await pool.query<{ id: string }>(
      "SELECT id FROM flaw.user_keys WHERE owner_id = $1 AND status = 'active'",
      [ownerId],
    );
    const dekId = existing.rows[0]?.id;
    if (dekId === undefined) {
      throw new Error("dek absente");
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.user_id', $1, true)", [ownerId]);
      await client.query(
        `INSERT INTO flaw.documents (
           id, owner_id, mode, format, font, projection_ct, projection_nonce, key_id, enc_version
         ) VALUES ($1, $2, 'prose', 'plain', 'serif', $3, $4, $5, 1)`,
        [id, ownerId, Buffer.from([1]), Buffer.from([2]), dekId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return id;
  }

  async function wipeUsers(): Promise<void> {
    await pool.query("DELETE FROM flaw.users");
  }

  async function documentExists(ownerId: string, documentId: string): Promise<boolean> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.user_id', $1, true)", [ownerId]);
      const result = await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM flaw.documents WHERE id = $1",
        [documentId],
      );
      await client.query("COMMIT");
      return (result.rows[0]?.n ?? 0) === 1;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  function floorAuth() {
    return openAuth({
      pool,
      pepper: secrets.hmacPepper,
      pepperId: "pep-hmac-2026-10",
      minLength: 15,
      idleDays: 30,
      maxDays: 90,
      argon: ARGON_FLOOR,
      now,
      onEvent: () => undefined,
    });
  }

  function adminEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      NODE_ENV: "test",
      DATABASE_HOST: "127.0.0.1",
      DATABASE_PORT: String(port),
      DATABASE_NAME: "flaw",
      DATABASE_USER: "flaw_app",
      DATABASE_PASSWORD_FILE: join(secretDir, "app_db_password"),
      BETTER_AUTH_SECRET_FILE: join(secretDir, "better_auth_secret"),
      FLAW_KEK_FILE: join(secretDir, "flaw_kek"),
      RECOVERY_PEPPER_FILE: join(secretDir, "recovery_pepper"),
      HMAC_PEPPER_FILE: join(secretDir, "hmac_pepper"),
      HMAC_PEPPER_ID: "pep-hmac-2026-10",
      PASSWORD_MIN_LENGTH: "15",
      PUBLIC_URL: ORIGIN,
      TRUSTED_ORIGINS: ORIGIN,
    };
  }

  function runAdmin(args: string[]) {
    return spawnSync(process.execPath, [cliPath, ...args], {
      encoding: "utf8",
      env: adminEnv(),
    });
  }

  beforeAll(async () => {
    pepper = validKey();
    secrets.kek = validKey();
    secrets.recoveryPepper = validKey();
    secrets.hmacPepper = pepper;
    const removed = docker(["rm", "-fv", container]);
    expect([0, 1]).toContain(removed.status);
    const started = docker([
      "run",
      "-d",
      "--name",
      container,
      "--network",
      "bridge",
      "-e",
      `POSTGRES_PASSWORD=${DB_PASSWORD}`,
      "-e",
      "POSTGRES_DB=flaw",
      "-e",
      "POSTGRES_USER=postgres",
      "-p",
      "127.0.0.1::5432",
      POSTGRES_IMAGE,
    ]);
    expect(started.status, started.stderr).toBe(0);
    const mapped = docker(["port", container, "5432/tcp"]);
    expect(mapped.status, mapped.stderr).toBe(0);
    const match = mapped.stdout.trim().match(/:(\d+)$/);
    expect(match).not.toBeNull();
    port = Number(match?.[1]);
    const deadline = Date.now() + 90_000;
    let ready = false;
    while (Date.now() < deadline) {
      const logs = docker(["logs", container]);
      const text = `${logs.stdout}\n${logs.stderr}`;
      const marker = text.lastIndexOf("PostgreSQL init process complete");
      if (marker >= 0 && text.slice(marker).includes("database system is ready to accept connections")) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(ready).toBe(true);
    secretDir = mkdtempSync(join(tmpdir(), "flaw-t007-secrets-"));
    writeFileSync(join(secretDir, "app_db_password"), DB_PASSWORD);
    writeFileSync(join(secretDir, "db_owner_password"), DB_PASSWORD);
    writeFileSync(join(secretDir, "better_auth_secret"), HEX);
    writeFileSync(join(secretDir, "flaw_kek"), secrets.kek);
    writeFileSync(join(secretDir, "recovery_pepper"), secrets.recoveryPepper);
    writeFileSync(join(secretDir, "hmac_pepper"), pepper);
    for (const name of ["app_db_password", "db_owner_password", "better_auth_secret", "flaw_kek", "recovery_pepper", "hmac_pepper"]) {
      chmodSync(join(secretDir, name), 0o600);
    }
    const prepared = docker(["exec", container, "mkdir", "-p", "/run/secrets", "/tmp/initdb"]);
    expect(prepared.status, prepared.stderr).toBe(0);
    for (const name of ["app_db_password", "db_owner_password"]) {
      const copied = docker(["cp", join(secretDir, name), `${container}:/run/secrets/${name}`]);
      expect(copied.status, copied.stderr).toBe(0);
    }
    expect(
      docker(["cp", join(root, "infra/initdb/01-role-applicatif.sh"), `${container}:/tmp/initdb/01-role-applicatif.sh`]).status,
    ).toBe(0);
    expect(
      docker(["cp", join(root, "infra/initdb/secret-valide.inc"), `${container}:/tmp/initdb/secret-valide.inc`]).status,
    ).toBe(0);
    expect(
      docker(["exec", "-u", "root", container, "chown", "70:70", "/run/secrets/app_db_password", "/run/secrets/db_owner_password"]).status,
    ).toBe(0);
    expect(
      docker(["exec", "-u", "root", container, "chmod", "440", "/run/secrets/app_db_password", "/run/secrets/db_owner_password"]).status,
    ).toBe(0);
    const init = docker([
      "exec",
      "-u",
      "postgres",
      "-e",
      "POSTGRES_USER=postgres",
      "-e",
      "POSTGRES_DB=flaw",
      container,
      "sh",
      "/tmp/initdb/01-role-applicatif.sh",
    ]);
    expect(init.status, `${init.stdout}\n${init.stderr}`).toBe(0);

    async function connectStable(user: string): Promise<Client> {
      let last = "connexion impossible";
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const client = new Client({
          host: "127.0.0.1",
          port,
          database: "flaw",
          user,
          password: DB_PASSWORD,
          connectionTimeoutMillis: 5000,
        });
        try {
          await client.connect();
          await client.query("SELECT 1");
          return client;
        } catch (error) {
          last = error instanceof Error ? error.message : "connexion impossible";
          await client.end().catch(() => undefined);
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
      }
      throw new Error(last);
    }

    owner = await connectStable("flaw_owner");
    await applyMigrations(owner);
    appClient = await connectStable("flaw_app");
    await assertAppRole(appClient);
    pool = new Pool({
      host: "127.0.0.1",
      port,
      database: "flaw",
      user: "flaw_app",
      password: DB_PASSWORD,
      max: 8,
    });
  }, 180_000);

  afterAll(async () => {
    process.stdout.write(`DB_TESTS_EXECUTED[${dbTestsLabel}]=${dbTests}\n`);
    await pool?.end().catch(() => undefined);
    await appClient?.end().catch(() => undefined);
    await owner?.end().catch(() => undefined);
    if (secretDir !== "") {
      rmSync(secretDir, { recursive: true, force: true });
    }
    docker(["rm", "-fv", container]);
  });

  function dbTest(name: string, fn: () => Promise<void>, timeout = 60_000): void {
    it(name, async () => {
      dbTests += 1;
      clock.ms = Date.parse("2026-01-15T00:00:00.000Z");
      await fn();
    }, timeout);
  }

  dbTest("re-hache un argon2id sous les paramètres cibles (SEC-AUTH-01)", async () => {
    const email = nextEmail();
    const userId = await seedUser(email, PASSWORD, ARGON_FLOOR);
    const targetApp = buildApp(config(), appOptions(ARGON_TARGET));
    const response = await sign(targetApp, email, PASSWORD, nextIp(), true);
    expect(response.statusCode).toBe(200);
    const stored = await pool.query<{ password_hash: string }>(
      "SELECT password_hash FROM flaw.accounts WHERE owner_id = $1",
      [userId],
    );
    expect(stored.rows[0]?.password_hash.startsWith("$argon2id$v=19$m=65536,t=3,p=1")).toBe(true);
    await targetApp.close();
  });

  dbTest("refuse le mot de passe provisoire après 24 h et ne le journalise pas (SEC-AUTH-02)", async () => {
    await wipeUsers();
    const email = nextEmail();
    const mark = logMark();
    const created = await floorAuth().createUser(email, nextIp());
    expect(created.password.length).toBeGreaterThanOrEqual(20);
    const key = hmacKey(pepper, "pep-hmac-2026-10");
    const marker = tempHmac(key, created.userId);
    const verification = await pool.query<{ identifier: string }>(
      "SELECT identifier FROM flaw.verifications WHERE identifier = $1",
      [marker],
    );
    expect(verification.rows).toHaveLength(1);
    expect(verification.rows[0]?.identifier).not.toContain(email);
    clock.ms += 24 * 60 * 60 * 1000 + 1000;
    const app = buildApp(config(), appOptions());
    const response = await sign(app, email, created.password, nextIp());
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual(problem(401));
    expect(response.headers["content-type"]).toContain("application/problem+json");
    const slice = logText.slice(mark);
    expect(slice).not.toContain(created.password);
    expect(response.body).not.toContain(created.password);
    await app.close();
  });

  dbTest("bloque la 6e tentative du compte puis accepte après le délai (SEC-AUTH-04)", async () => {
    const email = nextEmail();
    await seedUser(email, PASSWORD);
    const app = buildApp(config(), appOptions());
    const ip = nextIp();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failed = await sign(app, email, "mauvais-mot-de-passe", ip);
      expect(failed.statusCode).toBe(401);
      expect(failed.json()).toEqual(problem(401));
    }
    const limited = await sign(app, email, PASSWORD, ip);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["content-type"]).toContain("application/problem+json");
    expect(limited.json()).toEqual(problem(429, TOO_MANY));
    expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(60);
    clock.ms += 61_000;
    const accepted = await sign(app, email, PASSWORD, ip, true);
    expect(accepted.statusCode).toBe(200);
    await app.close();
  });

  dbTest("bloque la 21e tentative d'une même IP (SEC-AUTH-04)", async () => {
    const app = buildApp(config(), appOptions());
    const ip = nextIp();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const failed = await sign(app, nextEmail(), PASSWORD, ip);
      expect(failed.statusCode).toBe(401);
    }
    const limited = await sign(app, nextEmail(), PASSWORD, ip);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
    await app.close();
  });

  dbTest("ignore un en-tête forgé et une IP non fiable (SEC-AUTH-04)", async () => {
    const app = buildApp(config(), appOptions());
    const ip = nextIp();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const failed = await sign(app, nextEmail(), PASSWORD, ip);
      expect(failed.statusCode).toBe(401);
    }
    const forged = await sign(app, nextEmail(), PASSWORD, ip, undefined, {
      "x-forwarded-for": nextIp(),
    });
    expect(forged.statusCode).toBe(429);
    const fresh = await sign(app, nextEmail(), PASSWORD, nextIp());
    expect(fresh.statusCode).toBe(401);
    const untrusted = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in",
      remoteAddress: "203.0.113.50",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        "x-real-ip": ip,
      },
      payload: JSON.stringify({ identifier: nextEmail(), password: PASSWORD }),
    });
    expect(untrusted.statusCode).toBe(401);
    await app.close();
  });

  dbTest("rend le même corps et un temps comparable si le compte existe ou non (SEC-AUTH-05)", async () => {
    const app = buildApp(config(), appOptions());
    const known: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      const email = nextEmail();
      await seedUser(email, PASSWORD);
      known.push(email);
    }
    await sign(app, nextEmail(), PASSWORD, nextIp());
    await sign(app, known[0] ?? "", "mauvais-mot-de-passe", nextIp());
    const unknownTimes: number[] = [];
    const wrongTimes: number[] = [];
    let unknownBody = "";
    let wrongBody = "";
    for (let index = 0; index < 20; index += 1) {
      const unknownStarted = performance.now();
      const unknown = await sign(app, nextEmail(), PASSWORD, nextIp());
      unknownTimes.push(performance.now() - unknownStarted);
      const wrongStarted = performance.now();
      const wrong = await sign(app, known[index] ?? "", "mauvais-mot-de-passe", nextIp());
      wrongTimes.push(performance.now() - wrongStarted);
      expect(unknown.statusCode).toBe(401);
      expect(wrong.statusCode).toBe(401);
      expect(unknown.body).toBe(wrong.body);
      unknownBody = unknown.body;
      wrongBody = wrong.body;
    }
    expect(JSON.parse(unknownBody)).toEqual(problem(401));
    expect(JSON.parse(wrongBody)).toEqual(problem(401));
    expect(Math.abs(median(unknownTimes) - median(wrongTimes))).toBeLessThan(50);
    await app.close();
  }, 120_000);

  dbTest("refuse un changement sans mot de passe actuel et révoque les autres sessions (SEC-AUTH-10)", async () => {
    const email = nextEmail();
    await seedUser(email, PASSWORD);
    const app = buildApp(config(), appOptions());
    const ip = nextIp();
    const first = await sign(app, email, PASSWORD, ip, true, { "user-agent": "Firefox/128" });
    const second = await sign(app, email, PASSWORD, ip, true, { "user-agent": "Chrome/120" });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const firstCookie = setCookie(first.headers);
    const secondCookie = setCookie(second.headers);
    const missing = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      remoteAddress: "172.31.250.10",
      headers: {
        cookie: cookiePair(secondCookie),
        origin: ORIGIN,
        "content-type": "application/json",
        "x-real-ip": ip,
      },
      payload: JSON.stringify({ newPassword: `${PASSWORD}-nouveau` }),
    });
    expect(missing.statusCode).toBe(400);
    const wrong = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      remoteAddress: "172.31.250.10",
      headers: {
        cookie: cookiePair(secondCookie),
        origin: ORIGIN,
        "content-type": "application/json",
        "x-real-ip": ip,
      },
      payload: JSON.stringify({ currentPassword: "mauvais-mot-de-passe", newPassword: `${PASSWORD}-nouveau` }),
    });
    expect(wrong.statusCode).toBe(401);
    const mark = logMark();
    const changed = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      remoteAddress: "172.31.250.10",
      headers: {
        cookie: cookiePair(secondCookie),
        origin: ORIGIN,
        "content-type": "application/json",
        "x-real-ip": ip,
      },
      payload: JSON.stringify({ currentPassword: PASSWORD, newPassword: `${PASSWORD}-nouveau-1` }),
    });
    expect(changed.statusCode).toBe(200);
    expect(logText.slice(mark)).toContain("password_changed");
    const rotated = setCookie(changed.headers);
    expect(tokenOf(rotated)).not.toBe(tokenOf(secondCookie));
    const other = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: cookiePair(firstCookie) },
    });
    expect(other.statusCode).toBe(401);
    const previous = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: cookiePair(secondCookie) },
    });
    expect(previous.statusCode).toBe(401);
    const current = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: cookiePair(rotated) },
    });
    expect(current.statusCode).toBe(200);
    await app.close();
  });

  dbTest("ne stocke que le SHA-256 du jeton (SEC-SESS-01)", async () => {
    const email = nextEmail();
    await seedUser(email, PASSWORD);
    const app = buildApp(config(), appOptions());
    const response = await sign(app, email, PASSWORD, nextIp(), true);
    expect(response.statusCode).toBe(200);
    const header = setCookie(response.headers);
    expect(header).toContain("HttpOnly");
    const token = tokenOf(header);
    expect(response.body).not.toContain(token);
    const hash = hashSessionToken(token);
    const stored = await pool.query<{ token_hash: Buffer; n: number }>(
      "SELECT token_hash, octet_length(token_hash)::int AS n FROM flaw.sessions WHERE token_hash = $1",
      [hash],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.n).toBe(32);
    expect(Buffer.compare(stored.rows[0]?.token_hash ?? Buffer.alloc(0), hash)).toBe(0);
    const clear = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM flaw.sessions WHERE encode(token_hash, 'escape') LIKE $1",
      [`%${token}%`],
    );
    expect(clear.rows[0]?.n).toBe(0);
    const login = await app.inject({ method: "GET", url: "/login" });
    expect(login.body).not.toContain("localStorage");
    expect(login.body).not.toContain("sessionStorage");
    await app.close();
  });

  dbTest("pose le cookie __Host-flaw_session sans Domain (SEC-SESS-02)", async () => {
    const email = nextEmail();
    await seedUser(email, PASSWORD);
    const app = buildApp(config(), appOptions());
    const remembered = await sign(app, email, PASSWORD, nextIp(), true);
    const header = setCookie(remembered.headers);
    expect(header.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Path=/");
    expect(header).not.toContain("Domain=");
    expect(header).toContain("Max-Age=");
    const session = await sign(app, email, PASSWORD, nextIp(), false);
    const bare = setCookie(session.headers);
    expect(bare).not.toContain("Max-Age=");
    expect(bare).not.toContain("Domain=");
    await app.close();
  });

  dbTest("change le jeton à chaque connexion et révoque à la déconnexion (SEC-SESS-03)", async () => {
    const email = nextEmail();
    await seedUser(email, PASSWORD);
    const app = buildApp(config(), appOptions());
    const ip = nextIp();
    const first = await sign(app, email, PASSWORD, ip, true);
    const second = await sign(app, email, PASSWORD, ip, true);
    const firstToken = tokenOf(setCookie(first.headers));
    const secondHeader = setCookie(second.headers);
    const secondToken = tokenOf(secondHeader);
    expect(secondToken).not.toBe(firstToken);
    const signedOut = await app.inject({
      method: "POST",
      url: "/api/auth/sign-out",
      remoteAddress: "172.31.250.10",
      headers: {
        cookie: cookiePair(secondHeader),
        origin: ORIGIN,
        "content-type": "application/json",
        "x-real-ip": ip,
      },
      payload: "{}",
    });
    expect(signedOut.statusCode).toBe(200);
    const replay = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: cookiePair(secondHeader) },
    });
    expect(replay.statusCode).toBe(401);
    await app.close();
  });

  dbTest("expire à 30 jours d'inactivité, 90 jours absolus, et 24 h sans rester connecté (SEC-SESS-04, AC-097)", async () => {
    const email = nextEmail();
    const userId = await seedUser(email, PASSWORD);
    const app = buildApp(config(), appOptions());
    const ip = nextIp();
    const idle = await sign(app, email, PASSWORD, ip, true);
    const idleCookie = cookiePair(setCookie(idle.headers));
    clock.ms += 31 * 24 * 60 * 60 * 1000;
    const idleResponse = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie: idleCookie } });
    expect(idleResponse.statusCode).toBe(401);
    clock.ms = Date.parse("2026-01-15T00:00:00.000Z");
    const absolute = await sign(app, email, PASSWORD, ip, true);
    const absoluteCookie = cookiePair(setCookie(absolute.headers));
    await pool.query(
      "UPDATE flaw.sessions SET absolute_expires_at = $2 WHERE owner_id = $1 AND revoked_at IS NULL",
      [userId, new Date(clock.ms - 1000)],
    );
    const absoluteResponse = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: absoluteCookie },
    });
    expect(absoluteResponse.statusCode).toBe(401);
    clock.ms = Date.parse("2026-01-15T00:00:00.000Z");
    const brief = await sign(app, email, PASSWORD, ip, false);
    const briefCookie = cookiePair(setCookie(brief.headers));
    clock.ms += 25 * 60 * 60 * 1000;
    const briefResponse = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie: briefCookie } });
    expect(briefResponse.statusCode).toBe(401);
    clock.ms = Date.parse("2026-01-15T00:00:00.000Z");
    const alive = await sign(app, email, PASSWORD, ip, true);
    const aliveCookie = cookiePair(setCookie(alive.headers));
    clock.ms += 29 * 24 * 60 * 60 * 1000;
    const aliveResponse = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie: aliveCookie } });
    expect(aliveResponse.statusCode).toBe(200);
    await app.close();
  });

  dbTest("refuse une mutation cross-site et un formulaire, et n'altère rien en GET (SEC-WEB-05)", async () => {
    const email = nextEmail();
    const userId = await seedUser(email, PASSWORD);
    const documentId = await seedDocument(userId);
    const app = buildApp(config(), appOptions());
    const ip = nextIp();
    const signed = await sign(app, email, PASSWORD, ip, true);
    const cookie = cookiePair(setCookie(signed.headers));
    const evil = await app.inject({
      method: "DELETE",
      url: `/api/v1/documents/${documentId}`,
      remoteAddress: "172.31.250.10",
      headers: {
        cookie,
        origin: "https://evil.example",
        "x-real-ip": ip,
      },
    });
    expect(evil.statusCode).toBe(403);
    expect(evil.headers["content-type"]).toContain("application/problem+json");
    expect(evil.json()).toEqual(problem(403, ORIGIN_REJECTED));
    const evilJson = await app.inject({
      method: "DELETE",
      url: `/api/v1/documents/${documentId}`,
      remoteAddress: "172.31.250.10",
      headers: {
        cookie,
        origin: "https://evil.example",
        "content-type": "application/json",
        "x-real-ip": ip,
      },
      payload: "{}",
    });
    expect(evilJson.statusCode).toBe(403);
    const form = await app.inject({
      method: "DELETE",
      url: `/api/v1/documents/${documentId}`,
      remoteAddress: "172.31.250.10",
      headers: {
        cookie,
        origin: ORIGIN,
        "content-type": "application/x-www-form-urlencoded",
        "x-real-ip": ip,
      },
      payload: `id=${documentId}`,
    });
    expect(form.statusCode).toBe(403);
    expect(await documentExists(userId, documentId)).toBe(true);
    const cross = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      remoteAddress: "172.31.250.10",
      headers: {
        cookie,
        "content-type": "application/json",
        "sec-fetch-site": "cross-site",
        "x-real-ip": ip,
      },
      payload: "{}",
    });
    expect(cross.statusCode).toBe(403);
    const same = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      remoteAddress: "172.31.250.10",
      headers: {
        cookie,
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
        "x-real-ip": ip,
      },
      payload: "{}",
    });
    expect(same.statusCode).toBe(400);
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/documents/${documentId}`,
      remoteAddress: "172.31.250.10",
      headers: {
        cookie,
        origin: ORIGIN,
        "content-type": "application/json",
        "x-real-ip": ip,
      },
      payload: "{}",
    });
    expect(removed.statusCode).toBe(204);
    const getSignOut = await app.inject({
      method: "GET",
      url: "/api/auth/sign-out",
      headers: { cookie },
    });
    expect(getSignOut.statusCode).toBe(404);
    const still = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } });
    expect(still.statusCode).toBe(200);
    await app.close();
  });

  dbTest("n'inscrit personne, même si l'inscription est demandée (AC-031, SEC-API-01)", async () => {
    const before = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM flaw.users");
    const open = buildApp(config({ ALLOW_SIGNUP: "true", allowSignup: true }), appOptions());
    const response = await open.inject({
      method: "POST",
      url: "/api/auth/sign-up",
      headers: { "content-type": "application/json", origin: ORIGIN },
      payload: JSON.stringify({ identifier: nextEmail(), password: PASSWORD }),
    });
    expect(response.statusCode).toBe(404);
    const after = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM flaw.users");
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
    await open.close();
    await wipeUsers();
    const auth = floorAuth();
    const created = await auth.createUser(nextEmail(), nextIp());
    expect(created.password.length).toBeGreaterThanOrEqual(20);
    await expect(auth.createUser(nextEmail(), nextIp())).rejects.toThrow(/un seul compte/);
    const count = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM flaw.users");
    expect(count.rows[0]?.n).toBe(1);
  });

  dbTest("répond la même phrase sans e-mail pour un oubli de mot de passe (AC-032)", async () => {
    const email = nextEmail();
    await seedUser(email, PASSWORD);
    const app = buildApp(config(), appOptions());
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("non");
    }) as typeof fetch;
    const mark = logMark();
    try {
      const known = await app.inject({
        method: "POST",
        url: "/api/auth/forget-password",
        remoteAddress: "172.31.250.10",
        headers: { "content-type": "application/json", origin: ORIGIN, "x-real-ip": nextIp() },
        payload: JSON.stringify({ identifier: email }),
      });
      const unknown = await app.inject({
        method: "POST",
        url: "/api/auth/forget-password",
        remoteAddress: "172.31.250.10",
        headers: { "content-type": "application/json", origin: ORIGIN, "x-real-ip": nextIp() },
        payload: JSON.stringify({ identifier: nextEmail() }),
      });
      expect(known.statusCode).toBe(200);
      expect(unknown.statusCode).toBe(200);
      expect(known.body).toBe(unknown.body);
      expect(known.json()).toEqual({ message: FORGOT_MESSAGE });
      expect(calls).toBe(0);
      const slice = logText.slice(mark);
      expect(slice).toContain("password_reset_requested");
      expect(slice).not.toContain(email);
    } finally {
      globalThis.fetch = original;
    }
    await app.close();
  });

  dbTest("liste navigateur, système et activité, sans localisation (AC-033)", async () => {
    const email = nextEmail();
    await seedUser(email, PASSWORD);
    const app = buildApp(config(), appOptions());
    const signed = await sign(app, email, PASSWORD, nextIp(), true, {
      "user-agent": "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/auth/sessions",
      headers: { cookie: cookiePair(setCookie(signed.headers)) },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { devices: Array<Record<string, unknown>> };
    expect(body.devices.length).toBeGreaterThan(0);
    const device = body.devices[0];
    expect(device?.browser).toBe("Firefox");
    expect(device?.os).toBe("Linux");
    expect(typeof device?.lastActivity).toBe("string");
    const serialized = JSON.stringify(body);
    for (const word of ["country", "city", "location", "latitude", "longitude", "geo"]) {
      expect(serialized.toLowerCase()).not.toContain(word);
    }
    const columns = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_schema = 'flaw' AND table_name = 'sessions'
         AND column_name IN ('country', 'city', 'latitude', 'longitude')`,
    );
    expect(columns.rows[0]?.n).toBe(0);
    await app.close();
  });

  dbTest("isole les documents et le journal d'audit (AC-101, AC-030)", async () => {
    const emailA = nextEmail();
    const emailB = nextEmail();
    const userA = await seedUser(emailA, PASSWORD);
    const userB = await seedUser(emailB, PASSWORD);
    const documentA = await seedDocument(userA);
    const documentB = await seedDocument(userB);
    await pool.query("INSERT INTO flaw.audit_events (owner_id, event_type, result) VALUES ($1, 'read', 'ok')", [
      userB,
    ]);
    const app = buildApp(config(), appOptions());
    const signed = await sign(app, emailA, PASSWORD, nextIp(), true);
    const cookie = cookiePair(setCookie(signed.headers));
    const listed = await app.inject({ method: "GET", url: "/api/v1/documents", headers: { cookie } });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ items: [{ id: documentA }], nextCursor: null });
    expect(await documentExists(userA, documentA)).toBe(true);
    const again = await app.inject({ method: "GET", url: "/api/v1/documents", headers: { cookie } });
    expect(again.statusCode).toBe(200);
    expect(await documentExists(userA, documentA)).toBe(true);
    const denied = await app.inject({
      method: "DELETE",
      url: `/api/v1/documents/${documentB}`,
      remoteAddress: "172.31.250.10",
      headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
      payload: "{}",
    });
    expect(denied.statusCode).toBe(404);
    expect(await documentExists(userB, documentB)).toBe(true);
    const visible = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM flaw.audit_events");
    expect((visible.rows[0]?.n ?? 0) > 0).toBe(true);
    const own = await listAuditEvents(pool, userA);
    expect(own.every((row) => row.owner_id === userA)).toBe(true);
    expect(own.some((row) => row.owner_id === userB)).toBe(false);
    await app.close();
  });

  dbTest("refuse de démarrer si un GRANT dépasse le tableau, et check-roles le voit", async () => {
    expect(await checkRoles(owner)).toEqual([]);
    const conformant = runAdmin(["check-roles"]);
    expect(conformant.status, conformant.stderr).toBe(0);
    expect(conformant.stdout).toContain("rôles conformes");
    await owner.query("GRANT SELECT ON TABLE flaw.auth_events TO flaw_app");
    const hits: string[] = [];
    const webhook: Server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        hits.push(Buffer.concat(chunks).toString("utf8"));
        response.end("ok");
      });
    });
    await new Promise<void>((resolve) => {
      webhook.listen(0, "127.0.0.1", () => resolve());
    });
    const address = webhook.address();
    if (address === null || typeof address === "string") {
      throw new Error("écoute impossible");
    }
    const alertLogs = new PassThrough();
    let alertText = "";
    alertLogs.on("data", (chunk: Buffer) => {
      alertText += chunk.toString("utf8");
    });
    try {
      const drifted = await checkRoles(appClient);
      expect(drifted.some((line) => line.includes("privilege auth_events SELECT"))).toBe(true);
      const refused = runAdmin(["check-roles"]);
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain("privilege auth_events SELECT");
      expect(refused.stderr).not.toContain(DB_PASSWORD);
      await expect(
        assertAppPool(pool, (message) =>
          notifyStartupRefusal(
            config({ ALERT_WEBHOOK_URL: `http://127.0.0.1:${address.port}/` }),
            alertLogs,
            message,
          ),
        ),
      ).rejects.toThrow(/refus de démarrer/);
      expect(hits.join("\n")).not.toContain(DB_PASSWORD);
      expect(alertText).toContain("server_error");
      expect(alertText).not.toContain(DB_PASSWORD);
    } finally {
      await owner.query("REVOKE SELECT ON TABLE flaw.auth_events FROM flaw_app");
      await new Promise<void>((resolve, reject) => {
        webhook.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
    await assertAppRole(appClient);
    expect(await checkRoles(appClient)).toEqual([]);
  });

  dbTest("n'écrit que des HMAC dans auth_events et interdit la lecture (SEC-AUTH-05)", async () => {
    const email = nextEmail();
    const ip = nextIp();
    await seedUser(email, PASSWORD);
    const app = buildApp(config(), appOptions());
    const failed = await sign(app, email, "mauvais-mot-de-passe", ip);
    expect(failed.statusCode).toBe(401);
    const key = hmacKey(pepper, "pep-hmac-2026-10");
    const subject = subjectHmac(key, email);
    const rows = await owner.query<{ subject_hmac: string; ip_hmac: string }>(
      "SELECT subject_hmac, ip_hmac FROM flaw.auth_events WHERE subject_hmac = $1",
      [subject],
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    expect(rows.rows[0]?.subject_hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(rows.rows[0]?.ip_hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(rows.rows[0]?.subject_hmac).not.toBe(email);
    expect(rows.rows[0]?.ip_hmac).not.toBe(ip);
    await expect(pool.query("SELECT 1 FROM flaw.auth_events")).rejects.toThrow();
    await expect(pool.query("DELETE FROM flaw.auth_events")).rejects.toThrow();
    await expect(
      pool.query(
        "INSERT INTO flaw.auth_events (event_type, subject_hmac, ip_hmac) VALUES ('login_success', $1, $1)",
        ["a".repeat(64)],
      ),
    ).rejects.toThrow();
    const bucket = bucketHmac(key, `acct-fail|${email}`);
    const limits = await pool.query<{ bucket: string }>("SELECT bucket FROM flaw.rate_limits WHERE bucket = $1", [
      bucket,
    ]);
    expect(limits.rows).toHaveLength(1);
    expect(limits.rows[0]?.bucket).not.toContain(email);
    await app.close();
  });

  dbTest("refuse le Bearer éteint et le paramètre token (SEC-SESS-06)", async () => {
    const email = nextEmail();
    await seedUser(email, PASSWORD);
    const app = buildApp(config(), appOptions());
    const signed = await sign(app, email, PASSWORD, nextIp(), false);
    const token = tokenOf(setCookie(signed.headers));
    const cookie = cookiePair(setCookie(signed.headers));
    const bearer = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(bearer.statusCode).toBe(401);
    expect(bearer.headers["content-type"]).toContain("application/problem+json");
    expect(bearer.json()).toEqual(problem(401));
    const queried = await app.inject({
      method: "GET",
      url: "/api/v1/me?token=fuite",
      headers: { cookie },
    });
    expect(queried.statusCode).toBe(401);
    expect(queried.headers["content-type"]).toContain("application/problem+json");
    expect(queried.json()).toEqual(problem(401));
    const enabled = buildApp(config({ FLAW_AUTH_BEARER_ENABLED: "true", bearerEnabled: true }), appOptions());
    const still = await enabled.inject({
      method: "GET",
      url: "/api/v1/me?token=fuite",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(still.statusCode).toBe(401);
    expect(still.json()).toEqual(problem(401));
    await enabled.close();
    await app.close();
  });

  dbTest("accepte le jeton Bearer et refuse un hachage bcrypt (SEC-SESS-02, SEC-AUTH-01)", async () => {
    const email = nextEmail();
    const userId = await seedUser(email, PASSWORD);
    const app = buildApp(
      config({ FLAW_AUTH_BEARER_ENABLED: "true", bearerEnabled: true }),
      appOptions(),
    );
    const signed = await sign(app, email, PASSWORD, nextIp(), false);
    const token = tokenOf(setCookie(signed.headers));
    const me = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({
      id: userId,
      email,
      role: "user",
      locale: "fr",
      timeZone: "UTC",
      mfaEnrolled: true,
      passwordMustChange: false,
    });
    expect(me.headers["cache-control"]).toBe("no-store");
    await expect(
      pool.query(
        "INSERT INTO flaw.accounts (owner_id, provider_id, account_id, password_hash) VALUES ($1, 'credential', $2, $3)",
        [userId, nextEmail(), "$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012"],
      ),
    ).rejects.toThrow();
    const ip = nextIp();
    const cookie = cookiePair(setCookie(signed.headers));
    const short = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      remoteAddress: "172.31.250.10",
      headers: { cookie, origin: ORIGIN, "content-type": "application/json", "x-real-ip": ip },
      payload: JSON.stringify({ currentPassword: PASSWORD, newPassword: "a".repeat(14) }),
    });
    expect(short.statusCode).toBe(400);
    expect(short.headers["content-type"]).toContain("application/problem+json");
    expect(short.json()).toEqual(problem(400, PASSWORD_REJECTED));
    expect(short.body).not.toContain("a".repeat(14));
    const common = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      remoteAddress: "172.31.250.10",
      headers: { cookie, origin: ORIGIN, "content-type": "application/json", "x-real-ip": ip },
      payload: JSON.stringify({ currentPassword: PASSWORD, newPassword: "passwordpassword" }),
    });
    expect(common.statusCode).toBe(400);
    const emoji = `${"b".repeat(60)}${"😀".repeat(4)}`;
    const accepted = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      remoteAddress: "172.31.250.10",
      headers: { cookie, origin: ORIGIN, "content-type": "application/json", "x-real-ip": ip },
      payload: JSON.stringify({ currentPassword: PASSWORD, newPassword: emoji }),
    });
    expect(accepted.statusCode).toBe(200);
    const relog = await sign(app, email, emoji, nextIp(), true);
    expect(relog.statusCode).toBe(401);
    expect(relog.headers["content-type"]).toContain("application/problem+json");
    expect(relog.json()).toEqual(problem(401, MFA_REQUIRED));
    await app.close();
  });

  dbTest("affiche le mot de passe provisoire une seule fois via flaw-admin (SEC-AUTH-02, AC-031, AC-032)", async () => {
    await wipeUsers();
    const email = nextEmail();
    const created = runAdmin(["create-user", "--email", email]);
    expect(created.status, `${created.stdout}\n${created.stderr}`).toBe(0);
    const password = created.stdout.trim();
    expect(password.length).toBeGreaterThanOrEqual(20);
    expect(created.stdout.trim().split("\n")).toHaveLength(1);
    expect(created.stderr).not.toContain(password);
    const digest = createHash("sha256").update(password, "utf8").digest("hex");
    expect(created.stderr).not.toContain(digest);
    const stored = await pool.query<{ password_hash: string }>(
      "SELECT a.password_hash FROM flaw.accounts a WHERE a.account_id = $1",
      [email],
    );
    expect(stored.rows[0]?.password_hash.startsWith("$argon2id$v=19$")).toBe(true);
    expect(stored.rows[0]?.password_hash).not.toContain(password);
    const app = buildApp(config(), appOptions());
    const signed = await sign(app, email, password, nextIp(), true);
    expect(signed.statusCode).toBe(200);
    const cookie = cookiePair(setCookie(signed.headers));
    const duplicate = runAdmin(["create-user", "--email", nextEmail()]);
    expect(duplicate.status).not.toBe(0);
    expect(duplicate.stderr).toContain("un seul compte");
    expect(duplicate.stdout.trim()).toBe("");
    const reset = runAdmin(["reset-password", "--email", email]);
    expect(reset.status, reset.stderr).toBe(0);
    const next = reset.stdout.trim();
    expect(next).not.toBe(password);
    expect(next.length).toBeGreaterThanOrEqual(20);
    expect(reset.stderr).not.toContain(next);
    const oldSession = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } });
    expect(oldSession.statusCode).toBe(401);
    const oldPassword = await sign(app, email, password, nextIp());
    expect(oldPassword.statusCode).toBe(401);
    const fresh = await sign(app, email, next, nextIp(), true);
    expect(fresh.statusCode).toBe(200);
    await app.close();
  }, 180_000);

  dbTest("compte les échecs sur 15 minutes glissantes (SEC-AUTH-04)", async () => {
    const email = nextEmail();
    await seedUser(email, PASSWORD);
    const app = buildApp(config(), appOptions());
    const ip = nextIp();
    clock.ms = Date.parse("2026-01-15T00:14:00.000Z");
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const failed = await sign(app, email, "mauvais-mot-de-passe", ip);
      expect(failed.statusCode).toBe(401);
    }
    clock.ms = Date.parse("2026-01-15T00:16:00.000Z");
    const fifth = await sign(app, email, "mauvais-mot-de-passe", ip);
    expect(fifth.statusCode).toBe(401);
    const locked = await sign(app, email, PASSWORD, ip);
    expect(locked.statusCode).toBe(429);
    await app.close();
  });

  dbTest("compte les tentatives d'une IP sur 15 minutes glissantes (SEC-AUTH-04)", async () => {
    const app = buildApp(config(), appOptions());
    const ip = nextIp();
    clock.ms = Date.parse("2026-01-15T00:14:00.000Z");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const failed = await sign(app, nextEmail(), PASSWORD, ip);
      expect(failed.statusCode).toBe(401);
    }
    clock.ms = Date.parse("2026-01-15T00:16:00.000Z");
    const limited = await sign(app, nextEmail(), PASSWORD, ip);
    expect(limited.statusCode).toBe(429);
    await app.close();
  });

  dbTest("limite le changement de mot de passe (SEC-AUTH-10)", async () => {
    const email = nextEmail();
    await seedUser(email, PASSWORD);
    const app = buildApp(config(), appOptions());
    const signed = await sign(app, email, PASSWORD, nextIp(), true);
    const cookie = cookiePair(setCookie(signed.headers));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const wrong = await app.inject({
        method: "POST",
        url: "/api/auth/change-password",
        remoteAddress: "172.31.250.10",
        headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
        payload: JSON.stringify({ currentPassword: "mauvais-mot-de-passe", newPassword: `${PASSWORD}-nouveau-2` }),
      });
      expect(wrong.statusCode).toBe(401);
    }
    const limited = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      remoteAddress: "172.31.250.10",
      headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
      payload: JSON.stringify({ currentPassword: PASSWORD, newPassword: `${PASSWORD}-nouveau-3` }),
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
    await app.close();
  });

  dbTest("limite l'oubli de mot de passe (AC-032)", async () => {
    const app = buildApp(config(), appOptions());
    const ip = nextIp();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/forget-password",
        remoteAddress: "172.31.250.10",
        headers: { "content-type": "application/json", origin: ORIGIN, "x-real-ip": ip },
        payload: JSON.stringify({ identifier: nextEmail() }),
      });
      expect(response.statusCode).toBe(200);
    }
    const limited = await app.inject({
      method: "POST",
      url: "/api/auth/forget-password",
      remoteAddress: "172.31.250.10",
      headers: { "content-type": "application/json", origin: ORIGIN, "x-real-ip": ip },
      payload: JSON.stringify({ identifier: nextEmail() }),
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
    await app.close();
  });

  dbTest("ignore un second verrou identique et purge les compteurs périmés", async () => {
    const key = hmacKey(pepper, "pep-hmac-2026-10");
    const bucket = bucketHmac(key, "lock|conflit");
    const until = new Date(Date.parse("2026-01-15T00:05:00.000Z"));
    await insertLock(pool, bucket, until, 1);
    await insertLock(pool, bucket, until, 4);
    const rows = await pool.query<{ hits: number; window_start: Date }>(
      "SELECT hits, window_start FROM flaw.rate_limits WHERE bucket = $1 ORDER BY window_start",
      [bucket],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]?.hits).toBe(1);
    expect(rows.rows[1]?.hits).toBe(1);
    expect(rows.rows[1]?.window_start.toISOString()).toBe(LOCK_STAGE_ANCHOR.toISOString());
    const stale = bucketHmac(key, "lock|vieux");
    await pool.query("INSERT INTO flaw.rate_limits (bucket, window_start, hits) VALUES ($1, $2, 1)", [
      stale,
      new Date(Date.parse("2026-01-14T23:44:00.000Z")),
    ]);
    await purgeRateLimits(pool, new Date(Date.parse("2026-01-14T23:45:00.000Z")));
    const gone = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM flaw.rate_limits WHERE bucket = $1", [
      stale,
    ]);
    expect(gone.rows[0]?.n).toBe(0);
    const kept = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM flaw.rate_limits WHERE bucket = $1", [
      bucket,
    ]);
    expect(kept.rows[0]?.n).toBe(2);
  });

  dbTest("conserve l'escalade du verrouillage après purge des compteurs (SEC-AUTH-04)", async () => {
    const email = nextEmail();
    await seedUser(email, PASSWORD);
    const app = buildApp(config(), appOptions());
    const ip = nextIp();
    clock.ms = Date.parse("2026-01-15T00:00:00.000Z");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failed = await sign(app, email, "mauvais-mot-de-passe", ip);
      expect(failed.statusCode).toBe(401);
    }
    const locked = await sign(app, email, PASSWORD, ip);
    expect(locked.statusCode).toBe(429);
    expect(Number(locked.headers["retry-after"])).toBeLessThanOrEqual(60);
    await purgeRateLimits(pool, new Date(clock.ms + 24 * 60 * 60 * 1000));
    clock.ms += 120_000;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failed = await sign(app, email, "mauvais-mot-de-passe", ip);
      expect(failed.statusCode).toBe(401);
    }
    const escalated = await sign(app, email, PASSWORD, ip);
    expect(escalated.statusCode).toBe(429);
    const retry = Number(escalated.headers["retry-after"]);
    expect(retry).toBeGreaterThan(60);
    expect(retry).toBeLessThanOrEqual(300);
    await app.close();
  });

  dbTest("vérifie argon2 même quand le compte est inconnu", async () => {
    const spy = vi.spyOn(passwordModule, "verifyPassword");
    try {
      const app = buildApp(config(), appOptions());
      const response = await sign(app, nextEmail(), PASSWORD, nextIp());
      expect(response.statusCode).toBe(401);
      expect(spy).toHaveBeenCalled();
      const hashes = spy.mock.calls.map((call) => call[1]);
      expect(hashes.some((hash) => typeof hash === "string" && hash.startsWith("$argon2id$"))).toBe(true);
      await app.close();
    } finally {
      spy.mockRestore();
    }
  });

  dbTest("ignore l'en-tête x-user-id envoyé par le client", async () => {
    const emailA = nextEmail();
    const emailB = nextEmail();
    const userA = await seedUser(emailA, PASSWORD);
    const userB = await seedUser(emailB, PASSWORD);
    const app = buildApp(config(), appOptions());
    const anonymous = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { "x-user-id": userB },
    });
    expect(anonymous.statusCode).toBe(401);
    const signed = await sign(app, emailA, PASSWORD, nextIp(), true);
    const me = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: cookiePair(setCookie(signed.headers)), "x-user-id": userB },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({
      id: userA,
      email: emailA,
      role: "user",
      locale: "fr",
      timeZone: "UTC",
      mfaEnrolled: true,
      passwordMustChange: false,
    });
    expect(me.headers["cache-control"]).toBe("no-store");
    await app.close();
  });

  dbTest("accepte un DELETE sans corps quand l'origine est valide (SEC-WEB-05)", async () => {
    const email = nextEmail();
    const userId = await seedUser(email, PASSWORD);
    const documentId = await seedDocument(userId);
    const app = buildApp(config(), appOptions());
    const signed = await sign(app, email, PASSWORD, nextIp(), true);
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/documents/${documentId}`,
      remoteAddress: "172.31.250.10",
      headers: { cookie: cookiePair(setCookie(signed.headers)), origin: ORIGIN },
    });
    expect(removed.statusCode).toBe(204);
    expect(await documentExists(userId, documentId)).toBe(true);
    const trashed = await app.inject({
      method: "GET",
      url: `/api/v1/documents/${documentId}`,
      headers: { cookie: cookiePair(setCookie(signed.headers)) },
    });
    expect(trashed.statusCode).toBe(200);
    expect((trashed.json() as { deletedAt: string | null }).deletedAt).not.toBeNull();
    const live = await app.inject({
      method: "GET",
      url: "/api/v1/documents",
      headers: { cookie: cookiePair(setCookie(signed.headers)) },
    });
    expect((live.json() as { items: Array<{ id: string }> }).items.some((item) => item.id === documentId)).toBe(false);
    await app.close();
  });

  dbTest("accepte le formulaire de connexion quand l'origine est valide", async () => {
    const email = nextEmail();
    await seedUser(email, PASSWORD);
    const app = buildApp(config(), appOptions());
    const denied = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in",
      remoteAddress: "172.31.250.10",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `identifier=${encodeURIComponent(email)}&password=${encodeURIComponent(PASSWORD)}`,
    });
    expect(denied.statusCode).toBe(403);
    const device = devices.get(email);
    const accepted = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in",
      remoteAddress: "172.31.250.10",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: ORIGIN,
        ...(device === undefined ? {} : { cookie: `${DEVICE_COOKIE}=${device}` }),
      },
      payload: `identifier=${encodeURIComponent(email)}&password=${encodeURIComponent(PASSWORD)}`,
    });
    expect(accepted.statusCode).toBe(200);
    expect(setCookie(accepted.headers).startsWith(`${SESSION_COOKIE}=`)).toBe(true);
    const me = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: cookiePair(setCookie(accepted.headers)) },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ email });
    await app.close();
  });

  dbTest("refuse l'ancien nom de cookie et garde le nouveau (SEC-SESS-02)", async () => {
    const email = nextEmail();
    await seedUser(email, PASSWORD);
    const app = buildApp(config(), appOptions());
    const signed = await sign(app, email, PASSWORD, nextIp(), true);
    const token = tokenOf(setCookie(signed.headers));
    const legacy = "__Secure-flaw.session_token";
    const onlyLegacy = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: `${legacy}=${token}` },
    });
    expect(onlyLegacy.statusCode).toBe(401);
    expect(onlyLegacy.headers["content-type"]).toContain("application/problem+json");
    expect(onlyLegacy.json()).toEqual(problem(401));
    expect(onlyLegacy.headers["cache-control"]).toBe("no-store");
    const current = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(current.statusCode).toBe(200);
    expect(current.headers["cache-control"]).toBe("no-store");
    const both = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: `${legacy}=autre; ${SESSION_COOKIE}=${token}` },
    });
    expect(both.statusCode).toBe(200);
    await app.close();
  });

  dbTest("expose le profil User et no-store sur /me (API-001)", async () => {
    await wipeUsers();
    const email = nextEmail();
    const created = await floorAuth().createUser(email, nextIp());
    expect(await floorAuth().profile(created.userId)).toEqual({
      id: created.userId,
      email,
      role: "user",
      locale: "fr",
      timeZone: "UTC",
      mfaEnrolled: false,
      passwordMustChange: true,
    });
    const app = buildApp(config(), appOptions());
    const signed = await sign(app, email, created.password, nextIp());
    expect(signed.statusCode).toBe(200);
    const restricted = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: cookiePair(setCookie(signed.headers)) },
    });
    expect(restricted.statusCode).toBe(403);
    expect(restricted.headers["content-type"]).toContain("application/problem+json");
    expect(restricted.json()).toEqual(mfaRequiredFromContract());
    expect(restricted.json()).not.toEqual(problem(403, RESTRICTED));
    expect(restricted.headers["cache-control"]).toBe("no-store");
    const anonymous = await app.inject({ method: "GET", url: "/api/v1/me" });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.headers["content-type"]).toContain("application/problem+json");
    expect(anonymous.json()).toEqual(problem(401));
    expect(anonymous.headers["cache-control"]).toBe("no-store");
    await app.close();
  });

  dbTest("GET /me répond 403 problem+json no-store tant que la MFA n'est pas validée (API-001)", async () => {
    await wipeUsers();
    const email = nextEmail();
    const created = await floorAuth().createUser(email, nextIp());
    const app = buildApp(config(), appOptions());
    const signed = await sign(app, email, created.password, nextIp());
    expect(signed.statusCode).toBe(200);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: cookiePair(setCookie(signed.headers)) },
    });
    expect(response.statusCode).toBe(403);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual(mfaRequiredFromContract());
    expect(response.json()).not.toEqual(problem(403, RESTRICTED));
    const full = await sign(app, email, created.password, nextIp());
    expect((await floorAuth().profile(created.userId))?.mfaEnrolled).toBe(false);
    expect(full.statusCode).toBe(200);
    await app.close();
  });

  dbTest("accepte une seule fois un code émis sous pep-A puis le refuse sans pep-A (f4)", async () => {
    const email = nextEmail();
    const userId = await seedUser(email, PASSWORD);
    const pepperA = validKey();
    const pepperABytes = decodeValidatedKey(pepperA);
    if (pepperABytes === null) {
      throw new Error("poivre A");
    }
    const kept = recoveryCode();
    const dropped = recoveryCode();
    const keptMac = recoveryCodeHmac(pepperABytes, "pep-A", userId, kept);
    const droppedMac = recoveryCodeHmac(pepperABytes, "pep-A", userId, dropped);
    if (keptMac === null || droppedMac === null) {
      throw new Error("hmac");
    }
    await insertRecoveryCode(pool, userId, "pep-A", keptMac);
    await insertRecoveryCode(pool, userId, "pep-A", droppedMac);
    const secretsWithOld = {
      ...secrets,
      recoveryPepperOld: { "pep-A": pepperA },
    };
    const withOld = buildApp(
      config({ RECOVERY_PEPPER_ID: "pep-B", RECOVERY_PEPPER_OLD_IDS: "pep-A" }),
      { ...appOptions(), secrets: secretsWithOld },
    );
    const ip = nextIp();
    const attempt = (app: ReturnType<typeof buildApp>, code: string) =>
      app.inject({
        method: "POST",
        url: "/api/auth/sign-in",
        remoteAddress: "172.31.250.10",
        headers: {
          "content-type": "application/json",
          origin: ORIGIN,
          "x-real-ip": ip,
        },
        payload: JSON.stringify({ identifier: email, password: PASSWORD, recoveryCode: code }),
      });
    const accepted = await attempt(withOld, kept);
    expect(accepted.statusCode).toBe(200);
    const replay = await attempt(withOld, kept);
    expect(replay.statusCode).toBe(401);
    expect(replay.statusCode).not.toBe(500);
    expect(replay.headers["content-type"]).toContain("application/problem+json");
    const used = await pool.query<{ used_at: Date | null }>(
      "SELECT used_at FROM flaw.recovery_codes WHERE user_id = $1 AND code_hmac = $2",
      [userId, keptMac],
    );
    expect(used.rows[0]?.used_at).not.toBeNull();
    await withOld.close();

    const withoutOld = buildApp(
      config({ RECOVERY_PEPPER_ID: "pep-B", RECOVERY_PEPPER_OLD_IDS: "" }),
      { ...appOptions(), secrets: secretsWithOld },
    );
    const refused = await attempt(withoutOld, dropped);
    expect(refused.statusCode).toBe(401);
    expect(refused.statusCode).not.toBe(500);
    expect(refused.headers["content-type"]).toContain("application/problem+json");
    const still = await pool.query<{ used_at: Date | null }>(
      "SELECT used_at FROM flaw.recovery_codes WHERE user_id = $1 AND code_hmac = $2",
      [userId, droppedMac],
    );
    expect(still.rows[0]?.used_at).toBeNull();
    await withoutOld.close();
  });

  dbTest("un compte sans facteur ni marqueur d'enrôlement ne se connecte pas (R4)", async () => {
    const email = nextEmail();
    const passwordHash = await hashPassword(PASSWORD, ARGON_FLOOR);
    const inserted = await pool.query<{ id: string }>("INSERT INTO flaw.users (role) VALUES ('user') RETURNING id");
    const id = inserted.rows[0]?.id;
    if (id === undefined) {
      throw new Error("utilisateur absent");
    }
    await pool.query(
      "INSERT INTO flaw.accounts (owner_id, provider_id, account_id, password_hash) VALUES ($1, 'credential', $2, $3)",
      [id, email, passwordHash],
    );
    const app = buildApp(config(), appOptions());
    const signed = await sign(app, email, PASSWORD, nextIp());
    expect(signed.statusCode).toBe(401);
    expect(signed.headers["content-type"]).toContain("application/problem+json");
    expect(signed.json()).toEqual(problem(401));
    expect(signed.headers["set-cookie"]).toBeUndefined();
    const sessions = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM flaw.sessions WHERE owner_id = $1",
      [id],
    );
    expect(sessions.rows[0]?.n).toBe(0);
    await app.close();
  });

  dbTest("refuse un cookie et un Bearer d'identités différentes", async () => {
    const emailA = nextEmail();
    const emailB = nextEmail();
    await seedUser(emailA, PASSWORD);
    await seedUser(emailB, PASSWORD);
    const app = buildApp(config({ FLAW_AUTH_BEARER_ENABLED: "true", bearerEnabled: true }), appOptions());
    const signedA = await sign(app, emailA, PASSWORD, nextIp());
    const signedB = await sign(app, emailB, PASSWORD, nextIp());
    const tokenA = tokenOf(setCookie(signedA.headers));
    const tokenB = tokenOf(setCookie(signedB.headers));
    const mark = logMark();
    const conflict = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: `${SESSION_COOKIE}=${tokenA}`, authorization: `Bearer ${tokenB}` },
    });
    expect(conflict.statusCode).toBe(401);
    expect(conflict.headers["content-type"]).toContain("application/problem+json");
    expect(conflict.json()).toEqual(problem(401));
    const tail = logText.slice(mark);
    expect(tail).toContain("authorization_denied");
    expect(tail).not.toContain(tokenA);
    expect(tail).not.toContain(tokenB);
    const same = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: `${SESSION_COOKIE}=${tokenA}`, authorization: `Bearer ${tokenA}` },
    });
    expect(same.statusCode).toBe(200);
    await app.close();
  });

  dbTest("limite les jetons invalides par adresse", async () => {
    const email = nextEmail();
    await seedUser(email, PASSWORD);
    const app = buildApp(config(), appOptions());
    const ip = nextIp();
    const signed = await sign(app, email, PASSWORD, ip);
    const token = tokenOf(setCookie(signed.headers));
    const before = await pool.query<{ last_activity_at: Date }>(
      "SELECT last_activity_at FROM flaw.sessions WHERE token_hash = $1",
      [hashSessionToken(token)],
    );
    let limited: Awaited<ReturnType<typeof app.inject>> | undefined;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      limited = await app.inject({
        method: "GET",
        url: "/api/v1/me",
        remoteAddress: "172.31.250.10",
        headers: {
          cookie: `${SESSION_COOKIE}=${randomBytes(24).toString("base64url")}`,
          "x-real-ip": ip,
        },
      });
      if (limited.statusCode === 429) {
        break;
      }
    }
    expect(limited?.statusCode).toBe(429);
    expect(limited?.headers["content-type"]).toContain("application/problem+json");
    expect(limited?.json()).toEqual(problem(429, TOO_MANY));
    expect(limited?.headers["retry-after"]).toBeDefined();
    clock.ms += 1000;
    const blocked = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      remoteAddress: "172.31.250.10",
      headers: { cookie: `${SESSION_COOKIE}=${token}`, "x-real-ip": ip },
    });
    expect(blocked.statusCode).toBe(429);
    const after = await pool.query<{ last_activity_at: Date }>(
      "SELECT last_activity_at FROM flaw.sessions WHERE token_hash = $1",
      [hashSessionToken(token)],
    );
    expect(after.rows[0]?.last_activity_at.getTime()).toBe(before.rows[0]?.last_activity_at.getTime());
    const other = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      remoteAddress: "172.31.250.10",
      headers: { cookie: `${SESSION_COOKIE}=${token}`, "x-real-ip": nextIp() },
    });
    expect(other.statusCode).toBe(200);
    const unknown = await app.inject({
      method: "GET",
      url: "/api/v1/inconnu",
      remoteAddress: "172.31.250.10",
      headers: {
        cookie: `${SESSION_COOKIE}=${randomBytes(24).toString("base64url")}`,
        "x-real-ip": ip,
      },
    });
    expect(unknown.statusCode).toBe(429);
    expect(unknown.json()).toEqual(problem(429, TOO_MANY));
    await app.close();
  });

  dbTest("ignore un Bearer valide quand le drapeau est éteint", async () => {
    const email = nextEmail();
    await seedUser(email, PASSWORD);
    const app = buildApp(config(), appOptions());
    const signed = await sign(app, email, PASSWORD, nextIp());
    const token = tokenOf(setCookie(signed.headers));
    const before = await pool.query<{ last_activity_at: Date }>(
      "SELECT last_activity_at FROM flaw.sessions WHERE token_hash = $1",
      [hashSessionToken(token)],
    );
    clock.ms += 1000;
    const anonymous = await app.inject({ method: "GET", url: "/api/v1/inconnu" });
    const bearer = await app.inject({
      method: "GET",
      url: "/api/v1/inconnu",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(bearer.statusCode).toBe(401);
    expect(bearer.headers["content-type"]).toContain("application/problem+json");
    expect(bearer.json()).toEqual(anonymous.json());
    expect(bearer.json()).toEqual(problem(401));
    const after = await pool.query<{ last_activity_at: Date }>(
      "SELECT last_activity_at FROM flaw.sessions WHERE token_hash = $1",
      [hashSessionToken(token)],
    );
    expect(after.rows[0]?.last_activity_at.getTime()).toBe(before.rows[0]?.last_activity_at.getTime());
    await app.close();
  });

  dbTest("un cookie valide et un Bearer étranger sur une route inconnue restent un 404 (Q-019)", async () => {
    const emailA = nextEmail();
    const emailB = nextEmail();
    await seedUser(emailA, PASSWORD);
    await seedUser(emailB, PASSWORD);
    const app = buildApp(config(), appOptions());
    const signedA = await sign(app, emailA, PASSWORD, nextIp());
    const signedB = await sign(app, emailB, PASSWORD, nextIp());
    const tokenA = tokenOf(setCookie(signedA.headers));
    const tokenB = tokenOf(setCookie(signedB.headers));
    const missing = await app.inject({
      method: "GET",
      url: "/api/v1/inconnu",
      headers: {
        cookie: `${SESSION_COOKIE}=${tokenA}`,
        authorization: `Bearer ${tokenB}`,
      },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers["content-type"]).toContain("application/problem+json");
    expect(missing.json()).toEqual(problem(404));
    await app.close();
  });

  dbTest("un changement de mot de passe révoque l'appareil de confiance", async () => {
    const email = nextEmail();
    await seedUser(email, PASSWORD);
    const app = buildApp(config(), appOptions());
    const signed = await sign(app, email, PASSWORD, nextIp());
    const changed = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      remoteAddress: "172.31.250.10",
      headers: {
        cookie: cookiePair(setCookie(signed.headers)),
        origin: ORIGIN,
        "content-type": "application/json",
        "x-real-ip": nextIp(),
      },
      payload: JSON.stringify({ currentPassword: PASSWORD, newPassword: "phrase-nouvelle-ok" }),
    });
    expect(changed.statusCode).toBe(200);
    const relog = await sign(app, email, "phrase-nouvelle-ok", nextIp());
    expect(relog.statusCode).toBe(401);
    expect(relog.headers["content-type"]).toContain("application/problem+json");
    expect(relog.json()).toEqual(problem(401, MFA_REQUIRED));
    await app.close();
  });

  dbTest("liste les sessions v1 sans IP ni localisation (API-003, SEC-SESS-05)", async () => {
    const email = nextEmail();
    const ip = nextIp();
    await seedUser(email, PASSWORD);
    const app = buildApp(config(), appOptions());
    const anonymous = await app.inject({ method: "GET", url: "/api/v1/me/sessions" });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.headers["content-type"]).toContain("application/problem+json");
    expect(anonymous.headers["cache-control"]).toBe("no-store");
    expect(anonymous.json()).toEqual(problem(401));
    const signed = await sign(app, email, PASSWORD, ip, true, {
      "user-agent": "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/me/sessions",
      headers: { cookie: cookiePair(setCookie(signed.headers)) },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json() as Array<Record<string, unknown>>;
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      browser: "Firefox",
      os: "Linux",
      deviceType: "desktop",
      deviceLabel: "Firefox · Linux",
      current: true,
    });
    expect(body[0]?.lastSeenAt).toBe(body[0]?.lastActivity);
    expect(typeof body[0]?.createdAt).toBe("string");
    expect(typeof body[0]?.expiresAt).toBe("string");
    assertNoLocation(body);
    expect(JSON.stringify(body)).not.toContain(ip);
    await app.close();
  });

  dbTest("révoque les autres sessions sous 5 min, sinon 403 (API-004, SEC-AUTH-11)", async () => {
    const email = nextEmail();
    await seedUser(email, PASSWORD);
    const app = buildApp(config(), appOptions());
    const ua = { "user-agent": "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0" };
    const first = await sign(app, email, PASSWORD, nextIp(), true, ua);
    const second = await sign(app, email, PASSWORD, nextIp(), true, ua);
    const third = await sign(app, email, PASSWORD, nextIp(), true, ua);
    const cookies = [first, second, third].map((response) => cookiePair(setCookie(response.headers)));
    const current = cookies[2] ?? "";
    const listed = await app.inject({ method: "GET", url: "/api/v1/me/sessions", headers: { cookie: current } });
    expect((listed.json() as unknown[]).length).toBe(3);
    clock.ms += 5 * 60 * 1000 - 1;
    const early = await app.inject({
      method: "DELETE",
      url: "/api/v1/me/sessions",
      headers: { origin: ORIGIN, cookie: current, "content-type": "application/json" },
      payload: "{}",
    });
    expect(early.statusCode).toBe(204);
    expect(early.body).toBe("");
    expect((await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie: current } })).statusCode).toBe(200);
    for (const cookie of cookies.slice(0, 2)) {
      const gone = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } });
      expect(gone.statusCode).toBe(401);
      expect(gone.headers["content-type"]).toContain("application/problem+json");
      expect(gone.headers["cache-control"]).toBe("no-store");
      expect(gone.json()).toEqual(problem(401));
    }
    clock.ms += 1;
    const late = await app.inject({
      method: "DELETE",
      url: "/api/v1/me/sessions",
      headers: { origin: ORIGIN, cookie: current, "content-type": "application/json" },
      payload: "{}",
    });
    expect(late.statusCode).toBe(403);
    expect(late.headers["content-type"]).toContain("application/problem+json");
    expect(late.headers["cache-control"]).toBe("no-store");
    expect(late.json()).toEqual(reauthRequiredProblem());
    expect(new URL((late.json() as { type: string }).type).pathname.endsWith("/reauth_required")).toBe(true);
    expect((await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie: current } })).statusCode).toBe(200);
    const fresh = await sign(app, email, PASSWORD, nextIp(), true, ua);
    const freshCookie = cookiePair(setCookie(fresh.headers));
    const again = await app.inject({
      method: "DELETE",
      url: "/api/v1/me/sessions",
      headers: { origin: ORIGIN, cookie: freshCookie, "content-type": "application/json" },
      payload: "{}",
    });
    expect(again.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie: current } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie: freshCookie } })).statusCode).toBe(200);
    await app.close();
  });

  dbTest("révoque une session et confond id inconnu et session étrangère (API-005, SEC-API-02)", async () => {
    const emailA = nextEmail();
    const emailB = nextEmail();
    await seedUser(emailA, PASSWORD);
    await seedUser(emailB, PASSWORD);
    const app = buildApp(config(), appOptions());
    const first = await sign(app, emailA, PASSWORD, nextIp(), true);
    const second = await sign(app, emailA, PASSWORD, nextIp(), true);
    const foreign = await sign(app, emailB, PASSWORD, nextIp(), true);
    const cookieA = cookiePair(setCookie(first.headers));
    const cookieOther = cookiePair(setCookie(second.headers));
    const cookieB = cookiePair(setCookie(foreign.headers));
    const mine = (await app.inject({ method: "GET", url: "/api/v1/me/sessions", headers: { cookie: cookieA } })).json() as Array<{
      id: string;
      current: boolean;
    }>;
    const target = mine.find((row) => row.current === false);
    const theirs = (await app.inject({ method: "GET", url: "/api/v1/me/sessions", headers: { cookie: cookieB } })).json() as Array<{
      id: string;
    }>;
    expect(target).toBeDefined();
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/me/sessions/${target?.id}`,
      headers: { origin: ORIGIN, cookie: cookieA, "content-type": "application/json" },
      payload: "{}",
    });
    expect(removed.statusCode).toBe(204);
    const dead = await app.inject({ method: "GET", url: "/api/v1/me/sessions", headers: { cookie: cookieOther } });
    expect(dead.statusCode).toBe(401);
    expect(dead.headers["content-type"]).toContain("application/problem+json");
    expect(dead.headers["cache-control"]).toBe("no-store");
    expect(dead.json()).toEqual(problem(401));
    expect((await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie: cookieA } })).statusCode).toBe(200);
    const unknown = await app.inject({
      method: "DELETE",
      url: "/api/v1/me/sessions/00000000-0000-4000-8000-000000000099",
      headers: { origin: ORIGIN, cookie: cookieA, "content-type": "application/json" },
      payload: "{}",
    });
    const other = await app.inject({
      method: "DELETE",
      url: `/api/v1/me/sessions/${theirs[0]?.id}`,
      headers: { origin: ORIGIN, cookie: cookieA, "content-type": "application/json" },
      payload: "{}",
    });
    expect(unknown.statusCode).toBe(404);
    expect(other.statusCode).toBe(404);
    expect(unknown.body).toBe(other.body);
    expect(unknown.headers["content-type"]).toContain("application/problem+json");
    expect(other.headers["content-type"]).toContain("application/problem+json");
    expect(unknown.headers["cache-control"]).toBe("no-store");
    expect(other.headers["cache-control"]).toBe("no-store");
    expect(unknown.json()).toEqual(problem(404));
    expect((await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie: cookieB } })).statusCode).toBe(200);
    await app.close();
  });

  dbTest("journalise new_login sans IP et refuse ces routes en session restreinte (SEC-AUTH-14)", async () => {
    const email = nextEmail();
    const ip = nextIp();
    await seedUser(email, PASSWORD);
    const app = buildApp(config(), appOptions());
    const mark = logMark();
    const signed = await sign(app, email, PASSWORD, ip, true, {
      "user-agent": "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
    });
    const lines = logText
      .slice(mark)
      .split("\n")
      .filter((line) => line.includes('"new_login"'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(ip);
    const record = JSON.parse(lines[0] ?? "{}") as { type: string; browser?: string; os?: string; ip: unknown };
    expect(record).toMatchObject({ type: "new_login", browser: "Firefox", os: "Linux", ip: null });
    const markAgain = logMark();
    await sign(app, email, PASSWORD, nextIp(), true, {
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Firefox/128.0",
    });
    const again = logText
      .slice(markAgain)
      .split("\n")
      .filter((line) => line.includes('"new_login"'));
    expect(again).toHaveLength(1);
    expect(JSON.parse(again[0] ?? "{}")).toMatchObject({ browser: "Firefox", os: "macOS", ip: null });
    const cookie = cookiePair(setCookie(signed.headers));
    await pool.query("UPDATE flaw.sessions SET restricted = true WHERE token_hash = $1", [
      hashSessionToken(tokenOf(setCookie(signed.headers))),
    ]);
    const expected = mfaRequiredFromContract();
    for (const request of [
      { method: "GET" as const, url: "/api/v1/me/sessions" },
      { method: "DELETE" as const, url: "/api/v1/me/sessions" },
      { method: "DELETE" as const, url: "/api/v1/me/sessions/00000000-0000-4000-8000-000000000099" },
    ]) {
      const response = await app.inject({
        method: request.method,
        url: request.url,
        headers: {
          cookie,
          ...(request.method === "DELETE" ? { origin: ORIGIN, "content-type": "application/json" } : {}),
        },
        ...(request.method === "DELETE" ? { payload: "{}" } : {}),
      });
      expect(response.statusCode, request.url).toBe(403);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toEqual(expected);
    }
    await app.close();
    await wipeUsers();
    const provisionalEmail = nextEmail();
    const created = await floorAuth().createUser(provisionalEmail, nextIp());
    const provisional = buildApp(config(), appOptions());
    const markRestricted = logMark();
    const opened = await sign(provisional, provisionalEmail, created.password, nextIp(), false, {
      "user-agent": "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
    });
    expect(opened.statusCode).toBe(200);
    expect(logText.slice(markRestricted)).not.toContain("new_login");
    await provisional.close();
  });
});
