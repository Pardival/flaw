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
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assertAppPool, buildApp, notifyStartupRefusal } from "../app.ts";
import { loadConfig, type AppConfig } from "../config/load.ts";
import type { LoadedSecrets } from "../config/secrets.ts";
import { applyMigrations, assertAppRole } from "../db/migrate.ts";
import { validateKeyMaterial } from "../platform/healthz.ts";
import { checkRoles } from "../admin/check-roles.ts";
import { hashSessionToken, serializeSessionCookie } from "./cookie.ts";
import { summarizeDevice } from "./device.ts";
import { bucketHmac, hmacKey, subjectHmac, tempHmac } from "./hmac.ts";
import {
  AUTH_REQUIRED,
  FORGOT_MESSAGE,
  INVALID_LOGIN,
  LOGIN_HTML,
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
import { AUTH_ROUTES } from "./routes.ts";
import { openAuth } from "./service.ts";
import { listAuditEvents } from "./store.ts";

const POSTGRES_IMAGE =
  "postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873";
const DB_PASSWORD = "0123456789abcdef0123456789abcdef";
const HEX = "0123456789abcdef0123456789abcdef";
const ORIGIN = "https://flaw.test";
const PASSWORD = "phrase-secrete-ok";
const TRACKERS = ["google-analytics", "googletagmanager", "segment.io", "plausible.io", "doubleclick.net"];
const root = fileURLToPath(new URL("../../../../", import.meta.url));
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
    expect(LOGIN_HTML).toContain('autocomplete="new-password"');
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
    expect(cookie.startsWith("__Secure-flaw.session_token=")).toBe(true);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain("Domain=");
    expect(cookie).not.toContain("Max-Age");
    expect(serializeSessionCookie("jeton", 90)).toContain("Max-Age=90");
  });

  it("documente la conversion key_id sans l'exécuter et ne réécrit pas 0000 (0002)", () => {
    const init = readFileSync(join(root, "apps/server/drizzle/0000_init.sql"), "utf8");
    const authSql = readFileSync(join(root, "apps/server/drizzle/0001_auth.sql"), "utf8");
    const dek = readFileSync(join(root, "apps/server/drizzle/0002_dek_audit.sql"), "utf8");
    expect(init).toContain("token_hash text NOT NULL");
    expect(authSql).toContain("password_hash");
    expect(authSql).toContain("TYPE bytea");
    expect(authSql.toLowerCase()).not.toContain("country");
    expect(authSql.toLowerCase()).not.toContain("latitude");
    expect(dek).toContain("USING key_id::uuid");
    expect(dek.toLowerCase()).toContain("sans objet");
    expect(dek.toLowerCase()).toContain("kek");
    expect(executableSql(dek)).not.toContain("alter column key_id type uuid");
    const dockerfile = readFileSync(join(root, "apps/server/Dockerfile"), "utf8");
    expect(dockerfile).toContain("/usr/local/bin/flaw-admin");
  });

  it("exige une session sur les routes protégées et laisse la santé sans version (SEC-API-01, AC-030)", async () => {
    const app = buildApp(config());
    const health = await app.inject({ method: "GET", url: "/api/v1/healthz" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ok", clientIp: expect.any(String) });
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
      const url = route.url.includes(":id") ? "/api/v1/documents/00000000-0000-4000-8000-000000000001" : route.url;
      const response = await app.inject({
        method: route.method,
        url,
        headers: { "content-type": "application/json", origin: ORIGIN },
        payload: route.method === "GET" ? undefined : "{}",
      });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(401);
      expect(response.json()).toEqual({ message: AUTH_REQUIRED });
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

  async function sign(
    app: ReturnType<typeof buildApp>,
    identifier: string,
    password: string,
    ip: string,
    remember?: boolean,
    headers: Record<string, string> = {},
  ) {
    return app.inject({
      method: "POST",
      url: "/api/auth/sign-in",
      remoteAddress: "172.31.250.10",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        "x-real-ip": ip,
        ...headers,
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
    return id;
  }

  async function seedDocument(ownerId: string): Promise<string> {
    const id = crypto.randomUUID();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.user_id', $1, true)", [ownerId]);
      await client.query(
        `INSERT INTO flaw.documents (
           id, owner_id, mode, format, font, projection_ct, projection_nonce, key_id, enc_version
         ) VALUES ($1, $2, 'prose', 'plain', 'serif', $3, $4, 'kek-2026-10', 1)`,
        [id, ownerId, Buffer.from([1]), Buffer.from([2])],
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
    const removed = docker(["rm", "-f", container]);
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
    process.stdout.write(`DB_TESTS_EXECUTED=${dbTests}\n`);
    await pool?.end().catch(() => undefined);
    await appClient?.end().catch(() => undefined);
    await owner?.end().catch(() => undefined);
    if (secretDir !== "") {
      rmSync(secretDir, { recursive: true, force: true });
    }
    docker(["rm", "-f", container]);
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
    expect(response.json()).toEqual({ message: INVALID_LOGIN });
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
      expect(failed.json()).toEqual({ message: INVALID_LOGIN });
    }
    const limited = await sign(app, email, PASSWORD, ip);
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ message: TOO_MANY });
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
    expect(unknownBody).toContain(INVALID_LOGIN);
    expect(wrongBody).toContain(INVALID_LOGIN);
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
    const other = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: cookiePair(firstCookie) },
    });
    expect(other.statusCode).toBe(401);
    const current = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: cookiePair(secondCookie) },
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

  dbTest("pose le cookie __Secure- sans Domain (SEC-SESS-02)", async () => {
    const email = nextEmail();
    await seedUser(email, PASSWORD);
    const app = buildApp(config(), appOptions());
    const remembered = await sign(app, email, PASSWORD, nextIp(), true);
    const header = setCookie(remembered.headers);
    expect(header.startsWith("__Secure-flaw.session_token=")).toBe(true);
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
    expect(evil.json()).toEqual({ message: ORIGIN_REJECTED });
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
    await pool.query("INSERT INTO flaw.audit_events (owner_id, event_type, result) VALUES ($1, 'read', 'succes')", [
      userB,
    ]);
    const app = buildApp(config(), appOptions());
    const signed = await sign(app, emailA, PASSWORD, nextIp(), true);
    const cookie = cookiePair(setCookie(signed.headers));
    const listed = await app.inject({ method: "GET", url: "/api/v1/documents", headers: { cookie } });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ documents: [{ id: documentA }] });
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

  dbTest("accepte le jeton Bearer et refuse un hachage bcrypt (SEC-SESS-02, SEC-AUTH-01)", async () => {
    const email = nextEmail();
    const userId = await seedUser(email, PASSWORD);
    const app = buildApp(config(), appOptions());
    const signed = await sign(app, email, PASSWORD, nextIp(), false);
    const token = tokenOf(setCookie(signed.headers));
    const me = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ id: userId, identifier: email, role: "user" });
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
    expect(short.json()).toEqual({ message: PASSWORD_REJECTED });
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
    expect(relog.statusCode).toBe(200);
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
});
