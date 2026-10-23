/**
 * T-008 — AC-030, 031, 032, 033, 063, 064, 065, 066, 097, 098, 101
 * et SEC-AUTH-03, SEC-AUTH-08, SEC-LOG-08. Postgres 18.6 épinglé.
 * Le rejeu d'un même pas TOTP est refusé (A-012, ARC-SUM 0.4.18).
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  COLUMN,
  CryptoError,
  generateDek,
  openContent,
  sealContent,
  unwrapDek,
  wrapDek,
} from "@flaw/crypto";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import { DEVICE_COOKIE, SESSION_COOKIE } from "../auth/cookie.ts";
import { problem } from "../platform/problem.ts";
import type { AppConfig } from "../config/load.ts";
import type { LoadedSecrets } from "../config/secrets.ts";
import { decodeValidatedKey } from "../crypto/kek.ts";
import { applyMigrations, assertAppRole } from "../db/migrate.ts";
import { validateKeyMaterial } from "../platform/healthz.ts";
import {
  ENROLL_REFUSED,
  FORGOT_MESSAGE,
  MFA_REQUIRED,
  RESTRICTED,
  TOO_MANY,
} from "../auth/html.ts";
import { decodeBase32, hotp, recoveryCodeHmac, totpStep } from "../auth/mfa.ts";
import { ARGON_FLOOR } from "../auth/password.ts";
import { openAuth } from "../auth/service.ts";
import {
  claimTotpStep,
  consumeRecoveryCode,
  deleteVerificationsByValue,
  findActiveUserKey,
  insertRecoveryCode,
  insertUserKey,
  listAuditEvents,
  listRecoveryHmacs,
  withOwner,
} from "../auth/store.ts";
import { openApiOperations, restrictedDecision } from "../auth/restricted-session.ts";
import { main } from "./cli.ts";
import { resolvedDek, revokeDek } from "./revoke-dek.ts";

const POSTGRES_IMAGE =
  "postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873";
const DB_PASSWORD = "0123456789abcdef0123456789abcdef";
const HEX = "0123456789abcdef0123456789abcdef";
const ORIGIN = "https://flaw.test";
const KEK_ID = "kek-2026-10";
const PEPPER_ID = "pep-2026-10";
const NEW_PASSWORD = "autre-phrase-secrete-ok";
const CHROME = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0";
const FIREFOX = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Firefox/121.0";
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const dbTestsLabel = basename(fileURLToPath(import.meta.url));
const container = `flaw-t008-admin-${process.pid}`;
const openapi = JSON.parse(readFileSync(join(root, "openapi.json"), "utf8")) as {
  paths?: Record<string, unknown>;
};

const clock = { ms: Date.parse("2026-01-15T00:00:00.000Z") };
let dbTests = 0;
let ipN = 0;
let userN = 0;

function nextIp(): string {
  ipN += 1;
  return `203.0.113.${(ipN % 200) + 1}`;
}

function nextEmail(): string {
  userN += 1;
  return `admin${userN}@box.invalid`;
}

function now(): Date {
  return new Date(clock.ms);
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
    FLAW_KEK_ID: KEK_ID,
    RECOVERY_PEPPER_ID: PEPPER_ID,
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

function setCookie(headers: Record<string, unknown>): string {
  const raw = headers["set-cookie"];
  const list = Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? [raw] : [];
  const session = list.find((item) => item.startsWith(`${SESSION_COOKIE}=`));
  const value = session ?? list[0];
  if (value === undefined || value.length === 0) {
    throw new Error("set-cookie absent");
  }
  return value;
}

function deviceSetCookie(headers: Record<string, unknown>): string {
  const raw = headers["set-cookie"];
  const list = Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? [raw] : [];
  const device = list.find((item) => item.startsWith(`${DEVICE_COOKIE}=`));
  if (device === undefined) {
    throw new Error("cookie appareil absent");
  }
  return device;
}

function cookiePair(header: string): string {
  return header.split(";")[0] ?? "";
}

function totpAt(secret: string, at: Date, stepOffset = 0): string {
  const raw = decodeBase32(secret);
  if (raw === null) {
    throw new Error("secret totp illisible");
  }
  return hotp(raw, totpStep(at) + stepOffset);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hides(text: string, secret: string): void {
  expect(text).not.toContain(secret);
  expect(text).not.toContain(sha256(secret));
}

describe("flaw-admin et session restreinte", () => {
  let owner: Client;
  let appClient: Client;
  let pool: Pool;
  let port = 0;
  let secretDir = "";
  let webhook = "";
  let webhookServer: Server;
  const alerts: string[] = [];
  const apps: Array<ReturnType<typeof buildApp>> = [];

  const secrets = {
    databasePassword: DB_PASSWORD,
    betterAuthSecret: HEX,
    kek: "",
    recoveryPepper: "",
    hmacPepper: "",
  } as LoadedSecrets;

  function appOptions(argon: { m: number; t: number; p: number } = ARGON_FLOOR, secretOverride: LoadedSecrets = secrets) {
    return { pool, secrets: secretOverride, argon, now };
  }

  function track(app: ReturnType<typeof buildApp>): ReturnType<typeof buildApp> {
    apps.push(app);
    return app;
  }

  function floorAuth(override?: { kek: Uint8Array; kekId: string }) {
    const kek = override?.kek ?? decodeValidatedKey(secrets.kek);
    const recoveryPepper = decodeValidatedKey(secrets.recoveryPepper);
    if (kek === null || recoveryPepper === null) {
      throw new Error("clés de test");
    }
    return openAuth({
      pool,
      pepper: secrets.hmacPepper,
      pepperId: "pep-hmac-2026-10",
      minLength: 15,
      idleDays: 30,
      maxDays: 90,
      argon: ARGON_FLOOR,
      now,
      kek,
      kekId: override?.kekId ?? KEK_ID,
      recoveryPepper,
      recoveryPepperId: PEPPER_ID,
    });
  }

  function adminEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
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
      FLAW_KEK_ID: KEK_ID,
      RECOVERY_PEPPER_ID: PEPPER_ID,
      PASSWORD_MIN_LENGTH: "15",
      PUBLIC_URL: ORIGIN,
      TRUSTED_ORIGINS: ORIGIN,
      ALERT_WEBHOOK_URL: webhook,
      ...overrides,
    };
  }

  async function run(args: string[], env: NodeJS.ProcessEnv = adminEnv()): Promise<{ code: number; stdout: string; stderr: string }> {
    let out = "";
    let err = "";
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
    });
    try {
      const code = await main({ argv: args, env, stdout, stderr });
      return { code, stdout: out, stderr: err };
    } catch (error) {
      const message = error instanceof Error ? error.message : "echec";
      return { code: 1, stdout: out, stderr: `${err}${message}\n` };
    }
  }

  async function resetDb(): Promise<void> {
    const users = await pool.query<{ id: string }>("SELECT id FROM flaw.users");
    for (const row of users.rows) {
      await withOwner(pool, row.id, async (sql) => {
        await sql.query("DELETE FROM flaw.documents WHERE owner_id = $1", [row.id]);
      });
    }
    await pool.query("DELETE FROM flaw.users");
    await pool.query("DELETE FROM flaw.rate_limits");
    await owner.query("DELETE FROM flaw.keks");
  }

  async function sign(
    app: ReturnType<typeof buildApp>,
    identifier: string,
    password: string,
    extra: { totp?: string; recoveryCode?: string; ua?: string; cookie?: string } = {},
  ) {
    return app.inject({
      method: "POST",
      url: "/api/auth/sign-in",
      remoteAddress: "172.31.250.10",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        "x-real-ip": nextIp(),
        "user-agent": extra.ua ?? CHROME,
        ...(extra.cookie === undefined ? {} : { cookie: extra.cookie }),
      },
      payload: JSON.stringify({
        identifier,
        password,
        ...(extra.totp === undefined ? {} : { totp: extra.totp }),
        ...(extra.recoveryCode === undefined ? {} : { recoveryCode: extra.recoveryCode }),
      }),
    });
  }

  async function changePassword(app: ReturnType<typeof buildApp>, cookie: string, currentPassword: string, newPassword: string) {
    return app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      remoteAddress: "172.31.250.10",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        cookie,
        "user-agent": CHROME,
        "x-real-ip": nextIp(),
      },
      payload: JSON.stringify({ currentPassword, newPassword }),
    });
  }

  async function enroll(app: ReturnType<typeof buildApp>, cookie: string) {
    return app.inject({
      method: "POST",
      url: "/api/auth/mfa/enroll",
      remoteAddress: "172.31.250.10",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        cookie,
        "user-agent": CHROME,
      },
      payload: "{}",
    });
  }

  async function verify(app: ReturnType<typeof buildApp>, cookie: string, code: string, ua = CHROME) {
    return app.inject({
      method: "POST",
      url: "/api/auth/mfa/verify",
      remoteAddress: "172.31.250.10",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        cookie,
        "user-agent": ua,
      },
      payload: JSON.stringify({ code }),
    });
  }

  async function authed(app: ReturnType<typeof buildApp>, method: "GET" | "DELETE", url: string, cookie?: string) {
    return app.inject({
      method,
      url,
      headers: {
        origin: ORIGIN,
        ...(cookie === undefined ? {} : { cookie }),
        ...(method === "DELETE" ? { "content-type": "application/json" } : {}),
      },
      ...(method === "DELETE" ? { payload: "" } : {}),
    });
  }

  async function provisionalSession(email = nextEmail()): Promise<{
    app: ReturnType<typeof buildApp>;
    email: string;
    password: string;
    userId: string;
    cookie: string;
  }> {
    const created = await floorAuth().createUser(email, nextIp());
    const app = track(buildApp(config(), appOptions()));
    const response = await sign(app, email, created.password);
    expect(response.statusCode).toBe(200);
    return {
      app,
      email,
      password: created.password,
      userId: created.userId,
      cookie: cookiePair(setCookie(response.headers)),
    };
  }

  async function readyToEnroll(email = nextEmail()): Promise<{
    app: ReturnType<typeof buildApp>;
    email: string;
    userId: string;
    cookie: string;
    password: string;
  }> {
    const session = await provisionalSession(email);
    const changed = await changePassword(session.app, session.cookie, session.password, NEW_PASSWORD);
    expect(changed.statusCode).toBe(200);
    return {
      app: session.app,
      email,
      userId: session.userId,
      cookie: cookiePair(setCookie(changed.headers)),
      password: NEW_PASSWORD,
    };
  }

  let previousTls: string | undefined;

  beforeAll(async () => {
    previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    secrets.kek = validKey();
    secrets.recoveryPepper = validKey();
    secrets.hmacPepper = validKey();
    const certDir = mkdtempSync(join(tmpdir(), "flaw-webhook-"));
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-keyout",
        join(certDir, "key.pem"),
        "-out",
        join(certDir, "cert.pem"),
        "-days",
        "1",
        "-nodes",
        "-subj",
        "/CN=127.0.0.1",
      ],
      { stdio: "ignore" },
    );
    webhookServer = createServer(
      {
        key: readFileSync(join(certDir, "key.pem")),
        cert: readFileSync(join(certDir, "cert.pem")),
      },
      (request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      request.on("end", () => {
        alerts.push(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(204);
        response.end();
      });
    },
    );
    await new Promise<void>((resolve) => {
      webhookServer.listen(0, "127.0.0.1", resolve);
    });
    const address = webhookServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("webhook");
    }
    webhook = `https://127.0.0.1:${address.port}/alerte`;

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
    secretDir = mkdtempSync(join(tmpdir(), "flaw-t008-secrets-"));
    writeFileSync(join(secretDir, "app_db_password"), DB_PASSWORD);
    writeFileSync(join(secretDir, "db_owner_password"), DB_PASSWORD);
    writeFileSync(join(secretDir, "better_auth_secret"), HEX);
    writeFileSync(join(secretDir, "flaw_kek"), secrets.kek);
    writeFileSync(join(secretDir, "recovery_pepper"), secrets.recoveryPepper);
    writeFileSync(join(secretDir, "hmac_pepper"), secrets.hmacPepper);
    for (const name of ["app_db_password", "db_owner_password", "better_auth_secret", "flaw_kek", "recovery_pepper", "hmac_pepper"]) {
      chmodSync(join(secretDir, name), 0o600);
    }
    const prepared = docker(["exec", container, "mkdir", "-p", "/run/secrets", "/tmp/initdb"]);
    expect(prepared.status, prepared.stderr).toBe(0);
    for (const name of ["app_db_password", "db_owner_password"]) {
      expect(docker(["cp", join(secretDir, name), `${container}:/run/secrets/${name}`]).status).toBe(0);
    }
    expect(docker(["cp", join(root, "infra/initdb/01-role-applicatif.sh"), `${container}:/tmp/initdb/01-role-applicatif.sh`]).status).toBe(0);
    expect(docker(["cp", join(root, "infra/initdb/secret-valide.inc"), `${container}:/tmp/initdb/secret-valide.inc`]).status).toBe(0);
    expect(docker(["exec", "-u", "root", container, "chown", "70:70", "/run/secrets/app_db_password", "/run/secrets/db_owner_password"]).status).toBe(0);
    expect(docker(["exec", "-u", "root", container, "chmod", "440", "/run/secrets/app_db_password", "/run/secrets/db_owner_password"]).status).toBe(0);
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
    if (previousTls === undefined) {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    } else {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTls;
    }
    process.stdout.write(`DB_TESTS_EXECUTED[${dbTestsLabel}]=${dbTests}\n`);
    await Promise.all(apps.map((app) => app.close()));
    await pool?.end().catch(() => undefined);
    await appClient?.end().catch(() => undefined);
    await owner?.end().catch(() => undefined);
    if (webhookServer !== undefined) {
      await new Promise<void>((resolve) => webhookServer.close(() => resolve()));
    }
    if (secretDir !== "") {
      rmSync(secretDir, { recursive: true, force: true });
    }
    docker(["rm", "-fv", container]);
  });

  function dbTest(name: string, fn: () => Promise<void>, timeout = 60_000): void {
    it(name, async () => {
      dbTests += 1;
      clock.ms = Date.parse("2026-01-15T00:00:00.000Z");
      await resetDb();
      alerts.length = 0;
      try {
        await fn();
      } finally {
        while (apps.length > 0) {
          await apps.pop()?.close();
        }
      }
    }, timeout);
  }

  dbTest(
    "les commandes flaw-admin auditent, alertent, et n'impriment le mot de passe qu'une fois (SEC-AUTH-03, SEC-AUTH-08, SEC-LOG-08, AC-031)",
    async () => {
      const email = nextEmail();
      const created = await run(["create-user", "--email", email]);
      expect(created.code).toBe(0);
      const password = created.stdout.replace(/\n$/u, "");
      expect(created.stdout).toBe(`${password}\n`);
      expect(password.length).toBeGreaterThanOrEqual(20);
      hides(created.stderr, password);
      hides(alerts.join("\n"), password);
      expect(alerts).toEqual(["admin.create_user"]);
      const ownerId = (
        await pool.query<{ owner_id: string }>("SELECT owner_id FROM flaw.accounts WHERE account_id = $1", [email])
      ).rows[0]?.owner_id;
      expect(ownerId).toBeTruthy();
      const audits = await listAuditEvents(pool, ownerId ?? "");
      expect(audits.map((row) => row.event_type)).toContain("admin.create_user");

      alerts.length = 0;
      const duplicate = await run(["create-user", "--email", nextEmail()]);
      expect(duplicate.code).not.toBe(0);
      expect(duplicate.stdout).toBe("");
      expect(duplicate.stderr).toContain("un seul compte");
      expect(duplicate.stderr).toContain("admin.create_user");
      expect(duplicate.stderr).toContain("echec");
      expect(alerts).toEqual([]);

      const reset = await run(["reset-password", "--email", email]);
      expect(reset.code).toBe(0);
      const resetPassword = reset.stdout.replace(/\n$/u, "");
      expect(resetPassword).not.toBe(password);
      expect(resetPassword.length).toBeGreaterThanOrEqual(20);
      hides(reset.stderr, resetPassword);
      hides(alerts.join("\n"), resetPassword);
      expect(alerts).toContain("admin.reset_password");

      const disabled = await run(["disable-mfa", "--email", email]);
      expect(disabled.code).toBe(0);
      hides(disabled.stderr, disabled.stdout.replace(/\n$/u, ""));
      expect(alerts).toContain("admin.disable_mfa");

      const revoked = await run(["revoke-sessions", "--email", email]);
      expect(revoked.code).toBe(0);
      expect(revoked.stdout).toBe("sessions révoquées\n");
      hides(revoked.stdout, disabled.stdout.replace(/\n$/u, ""));
      expect(alerts).toContain("admin.revoke_sessions");
      const after = await listAuditEvents(pool, ownerId ?? "");
      for (const action of ["admin.reset_password", "admin.disable_mfa", "admin.revoke_sessions"]) {
        expect(after.map((row) => row.event_type)).toContain(action);
      }

      const seen = alerts.length;
      const roles = await run(["check-roles"]);
      expect(roles.code).toBe(0);
      expect(roles.stdout).toBe("rôles conformes\n");
      expect(roles.stderr).toContain("admin.check_roles");
      expect(alerts).toHaveLength(seen);

      const erasures = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM flaw.erasure_log");
      const documents = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM flaw.documents");
      const replay = await run(["replay-erasures"]);
      expect(replay.code).not.toBe(0);
      expect(replay.stdout).toBe("");
      expect(replay.stderr).toContain("non implémenté (T-051)");
      expect(replay.stderr).toContain("admin.replay_erasures");
      expect(replay.stderr).toContain("echec");
      expect(alerts).toHaveLength(seen);
      expect((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM flaw.erasure_log")).rows[0]?.n).toBe(erasures.rows[0]?.n);
      expect((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM flaw.documents")).rows[0]?.n).toBe(documents.rows[0]?.n);
    },
    180_000,
  );

  dbTest("la session restreinte refuse tout l'OpenAPI hors santé (A-012, AC-033)", async () => {
    const session = await provisionalSession();
    for (const op of openApiOperations(openapi)) {
      const isPublic = op.method === "GET" && op.path === "/api/v1/healthz";
      expect(restrictedDecision(op.method, op.path, isPublic)).toBe(isPublic ? "public" : "deny");
      const url = op.path.includes("{id}") ? op.path.replace("{id}", "00000000-0000-4000-8000-000000000001") : op.path;
      const method = op.method === "DELETE" ? "DELETE" : "GET";
      const anonymous = await authed(session.app, method, url);
      if (isPublic) {
        expect(anonymous.statusCode).toBe(200);
        expect(anonymous.json()).toEqual({ status: "ok" });
      } else {
        expect(anonymous.statusCode, `${op.method} ${op.path}`).toBe(401);
        expect(anonymous.headers["content-type"]).toContain("application/problem+json");
        expect(anonymous.json()).toEqual(problem(401));
        expect(anonymous.headers["cache-control"]).toBe("no-store");
      }
      const restricted = await authed(session.app, method, url, session.cookie);
      if (isPublic) {
        expect(restricted.statusCode).toBe(200);
      } else {
        expect(restricted.statusCode, `${op.method} ${op.path}`).toBe(403);
        expect(restricted.headers["content-type"]).toContain("application/problem+json");
        expect(restricted.json()).toEqual(problem(403, RESTRICTED));
      }
    }
    const denied = await enroll(session.app, session.cookie);
    expect(denied.statusCode).toBe(403);
    expect(denied.headers["content-type"]).toContain("application/problem+json");
    expect(denied.json()).toEqual(problem(403, ENROLL_REFUSED));
    const changing = await session.app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie: session.cookie },
      payload: "{}",
    });
    expect(changing.statusCode).not.toBe(403);
  });

  dbTest("le provisoire meurt à 24 h et la session restreinte à 15 min (négatif)", async () => {
    const session = await provisionalSession();
    clock.ms += 24 * 60 * 60 * 1000 - 1000;
    const still = await sign(session.app, session.email, session.password);
    expect(still.statusCode).toBe(200);
    clock.ms += 1000;
    const expired = await sign(session.app, session.email, session.password);
    expect(expired.statusCode).toBe(401);

    clock.ms = Date.parse("2026-01-15T00:00:00.000Z");
    await resetDb();
    const fresh = await provisionalSession();
    const far = new Date(clock.ms + 10 * 24 * 60 * 60 * 1000);
    await pool.query(
      "UPDATE flaw.sessions SET expires_at = $2, absolute_expires_at = $2 WHERE owner_id = $1 AND restricted = true",
      [fresh.userId, far],
    );
    clock.ms += 15 * 60 * 1000;
    const gone = await authed(fresh.app, "GET", "/api/v1/me", fresh.cookie);
    expect(gone.statusCode).toBe(401);
  });

  dbTest("reset-password révoque l'ancien secret et exige encore le TOTP (SEC-AUTH-08, AC-063)", async () => {
    const email = nextEmail();
    const ready = await readyToEnroll(email);
    const enrolled = await enroll(ready.app, ready.cookie);
    expect(enrolled.statusCode).toBe(200);
    const body = enrolled.json() as { secret: string; codes: string[] };
    const oldCookie = ready.cookie;
    const confirmed = await verify(ready.app, ready.cookie, totpAt(body.secret, now()));
    expect(confirmed.statusCode).toBe(200);
    const fullCookie = cookiePair(setCookie(confirmed.headers));
    expect((await authed(ready.app, "GET", "/api/v1/documents", fullCookie)).statusCode).toBe(200);

    const reset = await floorAuth().resetPassword(email, nextIp());
    expect((await sign(ready.app, email, NEW_PASSWORD)).statusCode).toBe(401);
    expect((await authed(ready.app, "GET", "/api/v1/me", oldCookie)).statusCode).toBe(401);
    expect((await authed(ready.app, "GET", "/api/v1/me", fullCookie)).statusCode).toBe(401);
    const factors = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM flaw.auth_factors WHERE owner_id = $1 AND kind = 'totp'",
      [ready.userId],
    );
    expect(factors.rows[0]?.n).toBe(1);

    const signed = await sign(ready.app, email, reset);
    expect(signed.statusCode).toBe(200);
    const restricted = cookiePair(setCookie(signed.headers));
    expect((await authed(ready.app, "GET", "/api/v1/documents", restricted)).statusCode).toBe(403);
    const changed = await changePassword(ready.app, restricted, reset, NEW_PASSWORD);
    expect(changed.statusCode).toBe(200);
    const nextCookie = cookiePair(setCookie(changed.headers));
    expect((await authed(ready.app, "GET", "/api/v1/documents", nextCookie)).statusCode).toBe(403);
    const wrong = await verify(ready.app, nextCookie, "000000");
    expect(wrong.statusCode).toBe(401);
    const ok = await verify(ready.app, nextCookie, totpAt(body.secret, now(), 1));
    expect(ok.statusCode).toBe(200);
    const elevated = cookiePair(setCookie(ok.headers));
    expect((await authed(ready.app, "GET", "/api/v1/documents", nextCookie)).statusCode).toBe(401);
    expect((await authed(ready.app, "GET", "/api/v1/documents", elevated)).statusCode).toBe(200);
  });

  dbTest("disable-mfa empêche l'ancien mot de passe d'enrôler un TOTP (SEC-AUTH-08, négatif)", async () => {
    const email = nextEmail();
    const ready = await readyToEnroll(email);
    const enrolled = await enroll(ready.app, ready.cookie);
    expect(enrolled.statusCode).toBe(200);
    const confirmed = await verify(ready.app, ready.cookie, totpAt((enrolled.json() as { secret: string }).secret, now()));
    expect(confirmed.statusCode).toBe(200);
    const fullCookie = cookiePair(setCookie(confirmed.headers));
    const provisional = await floorAuth().disableMfa(email, nextIp());
    expect((await sign(ready.app, email, NEW_PASSWORD)).statusCode).toBe(401);
    expect((await enroll(ready.app, fullCookie)).statusCode).toBe(401);
    const factors = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM flaw.auth_factors WHERE owner_id = $1",
      [ready.userId],
    );
    expect(factors.rows[0]?.n).toBe(0);
    const signed = await sign(ready.app, email, provisional);
    expect(signed.statusCode).toBe(200);
    const cookie = cookiePair(setCookie(signed.headers));
    expect((await enroll(ready.app, cookie)).statusCode).toBe(403);
    const changed = await changePassword(ready.app, cookie, provisional, NEW_PASSWORD);
    expect(changed.statusCode).toBe(200);
    const opened = await enroll(ready.app, cookiePair(setCookie(changed.headers)));
    expect(opened.statusCode).toBe(200);
    const again = opened.json() as { codes: string[] };
    expect(again.codes).toHaveLength(10);
  });

  dbTest("un code de secours ouvre une reconfiguration et les anciens codes meurent (AC-065, AC-066)", async () => {
    const email = nextEmail();
    const ready = await readyToEnroll(email);
    const enrolled = await enroll(ready.app, ready.cookie);
    expect(enrolled.statusCode).toBe(200);
    const body = enrolled.json() as { secret: string; codes: string[] };
    expect(body.codes).toHaveLength(10);
    for (const code of body.codes) {
      expect(code).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/);
    }
    const confirmed = await verify(ready.app, ready.cookie, totpAt(body.secret, now()));
    expect(confirmed.statusCode).toBe(200);
    const signedOut = await ready.app.inject({
      method: "POST",
      url: "/api/auth/sign-out",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie: cookiePair(setCookie(confirmed.headers)) },
      payload: "{}",
    });
    expect(signedOut.statusCode).toBe(200);

    const short = await sign(ready.app, email, NEW_PASSWORD, { recoveryCode: "ABCD", ua: FIREFOX });
    expect(short.statusCode).toBe(401);
    const recovered = await sign(ready.app, email, NEW_PASSWORD, { recoveryCode: body.codes[0] ?? "", ua: FIREFOX });
    expect(recovered.statusCode).toBe(200);
    const cookie = cookiePair(setCookie(recovered.headers));
    expect((await authed(ready.app, "GET", "/api/v1/documents", cookie)).statusCode).toBe(403);
    expect((await verify(ready.app, cookie, totpAt(body.secret, now(), 1))).statusCode).toBe(403);
    const again = await enroll(ready.app, cookie);
    expect(again.statusCode).toBe(200);
    const fresh = again.json() as { secret: string; codes: string[] };
    expect(fresh.codes).toHaveLength(10);
    const oldAgain = await sign(ready.app, email, NEW_PASSWORD, { recoveryCode: body.codes[1] ?? "", ua: FIREFOX });
    expect(oldAgain.statusCode).toBe(401);
    const lifted = await verify(ready.app, cookie, totpAt(fresh.secret, now(), 1));
    expect(lifted.statusCode).toBe(200);
    const elevated = cookiePair(setCookie(lifted.headers));
    expect((await authed(ready.app, "GET", "/api/v1/documents", cookie)).statusCode).toBe(401);
    expect((await authed(ready.app, "GET", "/api/v1/documents", elevated)).statusCode).toBe(200);
  });

  dbTest("un appareil inconnu redemande le TOTP et le même pas est refusé (AC-098, AC-063, A-012)", async () => {
    const email = nextEmail();
    const ready = await readyToEnroll(email);
    const enrolled = await enroll(ready.app, ready.cookie);
    const secret = (enrolled.json() as { secret: string }).secret;
    const confirmed = await verify(ready.app, ready.cookie, totpAt(secret, now()));
    expect(confirmed.statusCode).toBe(200);
    const cookie = cookiePair(setCookie(confirmed.headers));
    const me = await ready.app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.headers["cache-control"]).toBe("no-store");
    expect(me.json()).toEqual({
      id: ready.userId,
      email,
      role: "user",
      locale: "fr",
      timeZone: "UTC",
      mfaEnrolled: true,
      passwordMustChange: false,
    });
    const devices = await ready.app.inject({
      method: "GET",
      url: "/api/auth/sessions",
      headers: { cookie, "user-agent": CHROME },
    });
    expect(devices.statusCode).toBe(200);
    const listed = devices.json() as { devices: Array<Record<string, unknown>> };
    expect(listed.devices[0]).toMatchObject({ browser: "Chrome", os: "Linux" });
    expect(listed.devices[0]).toHaveProperty("lastActivity");
    expect(listed.devices[0]).not.toHaveProperty("location");
    expect(JSON.stringify(listed)).not.toMatch(/pays|ville|latitude|longitude/i);

    await ready.app.inject({
      method: "POST",
      url: "/api/auth/sign-out",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie },
      payload: "{}",
    });
    const deviceHeader = deviceSetCookie(confirmed.headers);
    expect(deviceHeader.startsWith(`${DEVICE_COOKIE}=`)).toBe(true);
    expect(deviceHeader).toContain("HttpOnly");
    expect(deviceHeader).toContain("Secure");
    expect(deviceHeader).toContain("SameSite=Strict");
    expect(deviceHeader).toContain("Path=/");
    expect(deviceHeader).not.toMatch(/;\s*Domain=/i);
    const devicePair = cookiePair(deviceHeader);
    const deviceToken = devicePair.slice(`${DEVICE_COOKIE}=`.length);
    const stored = await pool.query<{ identifier: string; value_hash: string }>(
      "SELECT identifier, value_hash FROM flaw.verifications WHERE value_hash = $1",
      [ready.userId],
    );
    expect(stored.rows.length).toBeGreaterThan(0);
    for (const row of stored.rows) {
      expect(row.identifier).not.toContain(deviceToken);
      expect(row.value_hash).not.toContain(deviceToken);
    }
    expect(stored.rows.some((row) => row.identifier === sha256(deviceToken))).toBe(true);

    expect((await sign(ready.app, email, NEW_PASSWORD, { ua: CHROME })).statusCode).toBe(401);
    expect((await sign(ready.app, email, NEW_PASSWORD, { ua: CHROME })).json()).toEqual(problem(401, MFA_REQUIRED));
    const trusted = await sign(ready.app, email, NEW_PASSWORD, { ua: CHROME, cookie: devicePair });
    expect(trusted.statusCode).toBe(200);
    const otherUa = await sign(ready.app, email, NEW_PASSWORD, { ua: FIREFOX, cookie: devicePair });
    expect(otherUa.statusCode).toBe(200);
    const required = await sign(ready.app, email, NEW_PASSWORD, { ua: FIREFOX });
    expect(required.statusCode).toBe(401);
    expect(required.headers["content-type"]).toContain("application/problem+json");
    expect(required.json()).toEqual(problem(401, MFA_REQUIRED));
    await deleteVerificationsByValue(pool, ready.userId);
    const revokedTrust = await sign(ready.app, email, NEW_PASSWORD, { ua: CHROME, cookie: devicePair });
    expect(revokedTrust.statusCode).toBe(401);
    expect(revokedTrust.headers["content-type"]).toContain("application/problem+json");
    expect(revokedTrust.json()).toEqual(problem(401, MFA_REQUIRED));
    const replay = await sign(ready.app, email, NEW_PASSWORD, { ua: FIREFOX, totp: totpAt(secret, now()) });
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toEqual(problem(401));
    const next = await sign(ready.app, email, NEW_PASSWORD, { ua: FIREFOX, totp: totpAt(secret, now(), 1) });
    expect(next.statusCode).toBe(200);
    const wrong = await sign(ready.app, email, "pas-le-bon-mot-de-passe", { ua: FIREFOX, totp: totpAt(secret, now(), 1) });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toEqual(problem(401));
  });

  dbTest("aucune route publique ne désactive le MFA (AC-064, négatif)", async () => {
    const ready = await readyToEnroll();
    const enrolled = await enroll(ready.app, ready.cookie);
    expect(enrolled.statusCode).toBe(200);
    const confirmed = await verify(ready.app, ready.cookie, totpAt((enrolled.json() as { secret: string }).secret, now()));
    expect(confirmed.statusCode).toBe(200);
    const anonymous = await ready.app.inject({
      method: "POST",
      url: "/api/auth/mfa/disable",
      headers: { "content-type": "application/json", origin: ORIGIN },
      payload: "{}",
    });
    expect(anonymous.statusCode).toBe(401);
    const known = await ready.app.inject({
      method: "POST",
      url: "/api/auth/mfa/disable",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        cookie: cookiePair(setCookie(confirmed.headers)),
      },
      payload: "{}",
    });
    expect(known.statusCode).toBe(404);
    const factors = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM flaw.auth_factors WHERE owner_id = $1 AND kind = 'totp'",
      [ready.userId],
    );
    expect(factors.rows[0]?.n).toBe(1);
  });

  dbTest("rotate-kek ré-enveloppe les DEK, retire l'ancienne KEK sans la détruire (Q-015)", async () => {
    const email = nextEmail();
    const ready = await readyToEnroll(email);
    const enrolled = await enroll(ready.app, ready.cookie);
    expect(enrolled.statusCode).toBe(200);
    const secret = (enrolled.json() as { secret: string }).secret;
    const beforeCodes = (await listRecoveryHmacs(pool, ready.userId)).map((row) => Buffer.from(row));
    expect(beforeCodes.length).toBe(10);
    const kek = decodeValidatedKey(secrets.kek);
    if (kek === null) {
      throw new Error("kek");
    }
    const active = await findActiveUserKey(pool, ready.userId);
    if (active === null) {
      throw new Error("dek absente");
    }
    const dek = unwrapDek(kek, ready.userId, {
      wrappedCt: new Uint8Array(active.wrapped_ct),
      wrappedNonce: new Uint8Array(active.wrapped_nonce),
      keyId: active.key_id,
      encVersion: active.enc_version,
      status: "active",
    });
    const docId = randomUUID();
    const plain = Buffer.from("projection-stable");
    const sealed = sealContent(dek, active.id, { ownerId: ready.userId, rowId: docId, column: COLUMN.projectionCt }, plain);
    await withOwner(pool, ready.userId, async (sql) => {
      await sql.query(
        `INSERT INTO flaw.documents (
           id, owner_id, mode, format, font, projection_ct, projection_nonce, key_id, enc_version
         ) VALUES ($1, $2, 'prose', 'plain', 'serif', $3, $4, $5, $6)`,
        [docId, ready.userId, Buffer.from(sealed.ciphertext), Buffer.from(sealed.nonce), active.id, sealed.encVersion],
      );
    });
    const extraDek = generateDek();
    const extraId = randomUUID();
    const extra = wrapDek(kek, KEK_ID, ready.userId, extraDek);
    await pool.query(
      `INSERT INTO flaw.user_keys (id, owner_id, wrapped_ct, wrapped_nonce, key_id, enc_version, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'revoked')`,
      [extraId, ready.userId, Buffer.from(extra.wrappedCt), Buffer.from(extra.wrappedNonce), KEK_ID, extra.encVersion],
    );
    dek.fill(0);
    const previousWrap = {
      wrappedCt: Uint8Array.from(active.wrapped_ct),
      wrappedNonce: Uint8Array.from(active.wrapped_nonce),
      keyId: active.key_id,
      encVersion: active.enc_version,
    };

    const oldPath = join(secretDir, "rotate-old");
    const newPath = join(secretDir, "rotate-new");
    copyFileSync(join(secretDir, "flaw_kek"), oldPath);
    chmodSync(oldPath, 0o400);
    const oldFileBytes = readFileSync(oldPath);
    const newMaterial = validKey();
    writeFileSync(newPath, `${newMaterial}\n`);
    chmodSync(newPath, 0o600);
    const rotated = await run(["rotate-kek", "--kek-id", "kek-2026-11", "--new-kek-file", newPath], adminEnv({ FLAW_KEK_FILE: oldPath }));
    expect(rotated.code, rotated.stderr).toBe(0);
    expect(rotated.stdout).toContain("kek tournée, retirer l'ancien secret");
    expect(rotated.stdout).toContain("FLAW_KEK_ID=kek-2026-11");
    expect(rotated.stdout).toContain("retired");
    expect(rotated.stdout).toContain("T-042");
    expect(rotated.stderr).not.toContain("EACCES");
    expect(existsSync(oldPath)).toBe(true);
    expect(readFileSync(oldPath).equals(oldFileBytes)).toBe(true);
    expect(existsSync(newPath)).toBe(true);
    expect(alerts).toEqual(["admin.rotate_kek"]);
    hides(rotated.stderr, newMaterial);
    hides(rotated.stderr, secrets.kek);

    const registry = await pool.query<{ id: string; status: string }>("SELECT id, status FROM flaw.keks ORDER BY id");
    expect(registry.rows).toEqual([
      { id: KEK_ID, status: "retired" },
      { id: "kek-2026-11", status: "active" },
    ]);
    const historical = unwrapDek(kek, ready.userId, { ...previousWrap, status: "active" });
    expect(historical).toHaveLength(32);
    historical.fill(0);

    const keys = await pool.query<{ id: string; key_id: string; status: string; wrapped_ct: Buffer; wrapped_nonce: Buffer; enc_version: number }>(
      "SELECT id, key_id, status, wrapped_ct, wrapped_nonce, enc_version FROM flaw.user_keys WHERE owner_id = $1",
      [ready.userId],
    );
    expect(keys.rows.every((row) => row.key_id === "kek-2026-11")).toBe(true);
    const revoked = keys.rows.find((row) => row.id === extraId);
    expect(revoked?.status).toBe("revoked");
    const newKek = decodeValidatedKey(newMaterial);
    if (newKek === null || revoked === undefined) {
      throw new Error("kek tournée illisible");
    }
    const opened = unwrapDek(newKek, ready.userId, {
      wrappedCt: new Uint8Array(revoked.wrapped_ct),
      wrappedNonce: new Uint8Array(revoked.wrapped_nonce),
      keyId: revoked.key_id,
      encVersion: revoked.enc_version,
      status: "revoked",
    });
    expect(timingSafeEqual(opened, extraDek)).toBe(true);
    expect(resolvedDek("revoked", opened)).toBeUndefined();
    expect(() =>
      unwrapDek(kek, ready.userId, {
        wrappedCt: new Uint8Array(revoked.wrapped_ct),
        wrappedNonce: new Uint8Array(revoked.wrapped_nonce),
        keyId: revoked.key_id,
        encVersion: revoked.enc_version,
        status: "revoked",
      }),
    ).toThrow(CryptoError);
    opened.fill(0);
    extraDek.fill(0);

    const afterCodes = await listRecoveryHmacs(pool, ready.userId);
    expect(afterCodes.map((row) => Buffer.from(row).toString("hex"))).toEqual(beforeCodes.map((row) => row.toString("hex")));
    const stored = await withOwner(pool, ready.userId, async (sql) => {
      const result = await sql.query<{ projection_ct: Buffer }>("SELECT projection_ct FROM flaw.documents WHERE id = $1", [docId]);
      return result.rows[0]?.projection_ct;
    });
    expect(Buffer.from(stored ?? []).equals(Buffer.from(sealed.ciphertext))).toBe(true);
    const audits = await listAuditEvents(pool, ready.userId);
    expect(audits.map((row) => row.event_type)).toContain("admin.rotate_kek");

    const app = track(buildApp(config({ FLAW_KEK_ID: "kek-2026-11" }), appOptions(ARGON_FLOOR, { ...secrets, kek: newMaterial })));
    const signed = await sign(app, email, NEW_PASSWORD);
    expect(signed.statusCode).toBe(200);
    const confirmed = await verify(app, cookiePair(setCookie(signed.headers)), totpAt(secret, now()));
    expect(confirmed.statusCode).toBe(200);

    await withOwner(pool, ready.userId, async (sql) => {
      await sql.query("DELETE FROM flaw.documents WHERE owner_id = $1", [ready.userId]);
    });
    await pool.query("DELETE FROM flaw.auth_factors WHERE owner_id = $1", [ready.userId]);
    await pool.query("DELETE FROM flaw.recovery_codes WHERE user_id = $1", [ready.userId]);
    await pool.query("DELETE FROM flaw.user_keys WHERE owner_id = $1 AND status <> 'revoked'", [ready.userId]);
    expect((await floorAuth().enroll(ready.userId, true)).kind).toBe("forbidden");
    const freshKek = decodeValidatedKey(newMaterial);
    if (freshKek === null) {
      throw new Error("nouvelle kek");
    }
    const fresh = await floorAuth({ kek: freshKek, kekId: "kek-2026-11" }).enroll(ready.userId, true);
    expect(fresh.kind).toBe("ok");
    const createdKey = await findActiveUserKey(pool, ready.userId);
    expect(createdKey?.key_id).toBe("kek-2026-11");
    freshKek.fill(0);
  });

  dbTest("rotate-kek ne détruit pas l'ancienne KEK si la vérification échoue (négatif)", async () => {
    const kekFile = join(secretDir, "flaw_kek");
    const samePath = await run(["rotate-kek", "--kek-id", "kek-2026-11", "--new-kek-file", kekFile]);
    expect(samePath.code).toBe(1);
    expect(samePath.stderr).toContain("requête invalide");
    expect(existsSync(kekFile)).toBe(true);

    const newPath = join(secretDir, "rotate-unused");
    writeFileSync(newPath, `${validKey()}\n`);
    chmodSync(newPath, 0o600);
    const sameId = await run(["rotate-kek", "--kek-id", KEK_ID, "--new-kek-file", newPath]);
    expect(sameId.code).toBe(1);
    expect(sameId.stderr).toContain("kek inattendue");
    expect(existsSync(kekFile)).toBe(true);

    const padded = join(secretDir, "rotate-padded");
    writeFileSync(padded, `${readFileSync(kekFile, "utf8")}\n`);
    chmodSync(padded, 0o600);
    const sameBytes = await run(["rotate-kek", "--kek-id", "kek-2026-12", "--new-kek-file", padded]);
    expect(sameBytes.code).toBe(1);
    expect(sameBytes.stderr).toContain("refus de démarrer : kek");
    expect(existsSync(kekFile)).toBe(true);

    const world = join(secretDir, "rotate-world");
    writeFileSync(world, `${validKey()}\n`);
    chmodSync(world, 0o644);
    const readable = await run(["rotate-kek", "--kek-id", "kek-2026-13", "--new-kek-file", world]);
    expect(readable.code).toBe(1);
    expect(readable.stderr).toContain("refus de démarrer : kek");
    expect(readable.stderr).toContain("0400");
    expect(existsSync(kekFile)).toBe(true);

    const created = await floorAuth().createUser(nextEmail(), nextIp());
    const broken = randomUUID();
    await pool.query(
      `INSERT INTO flaw.user_keys (id, owner_id, wrapped_ct, wrapped_nonce, key_id, enc_version, status)
       VALUES ($1, $2, $3, $4, $5, 1, 'active')`,
      [broken, created.userId, randomBytes(40), randomBytes(24), KEK_ID],
    );
    const oldPath = join(secretDir, "rotate-corrupt-old");
    copyFileSync(kekFile, oldPath);
    chmodSync(oldPath, 0o600);
    const failed = await run(
      ["rotate-kek", "--kek-id", "kek-2026-11", "--new-kek-file", newPath],
      adminEnv({ FLAW_KEK_FILE: oldPath }),
    );
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("decryption_failed");
    expect(existsSync(oldPath)).toBe(true);
    const row = await pool.query<{ key_id: string }>("SELECT key_id FROM flaw.user_keys WHERE id = $1", [broken]);
    expect(row.rows[0]?.key_id).toBe(KEK_ID);
    expect(alerts).toEqual([]);
  });

  dbTest("une DEK revoked refuse la résolution et une DEK retired reste résoluble (Q-011)", async () => {
    const created = await floorAuth().createUser(nextEmail(), nextIp());
    const kek = decodeValidatedKey(secrets.kek);
    if (kek === null) {
      throw new Error("kek");
    }
    const retiredDek = generateDek();
    const retiredId = randomUUID();
    const retiredWrap = wrapDek(kek, KEK_ID, created.userId, retiredDek);
    await insertUserKey(pool, {
      id: retiredId,
      userId: created.userId,
      wrappedCt: retiredWrap.wrappedCt,
      wrappedNonce: retiredWrap.wrappedNonce,
      kekId: KEK_ID,
      encVersion: retiredWrap.encVersion,
    });
    await pool.query("UPDATE flaw.user_keys SET status = 'retired' WHERE id = $1", [retiredId]);
    const activeDek = generateDek();
    const activeId = randomUUID();
    const activeWrap = wrapDek(kek, KEK_ID, created.userId, activeDek);
    await insertUserKey(pool, {
      id: activeId,
      userId: created.userId,
      wrappedCt: activeWrap.wrappedCt,
      wrappedNonce: activeWrap.wrappedNonce,
      kekId: KEK_ID,
      encVersion: activeWrap.encVersion,
    });
    const plain = Uint8Array.from([1, 2, 3, 4]);
    const sealed = sealContent(activeDek, activeId, { ownerId: created.userId, rowId: activeId, column: COLUMN.secretCt }, plain);
    let log = "";
    const stream = new PassThrough();
    stream.on("data", (chunk: Buffer) => {
      log += chunk.toString("utf8");
    });
    expect(await revokeDek(pool, created.userId, activeId, stream)).toBe(true);
    const statuses = await pool.query<{ id: string; status: string }>(
      "SELECT id, status FROM flaw.user_keys WHERE owner_id = $1",
      [created.userId],
    );
    expect(statuses.rows.find((row) => row.id === activeId)?.status).toBe("revoked");
    expect(statuses.rows.find((row) => row.id === retiredId)?.status).toBe("retired");
    await expect(pool.query("UPDATE flaw.user_keys SET status = 'active' WHERE id = $1", [activeId])).rejects.toThrow(/dek revoked/);
    const frozen = await pool.query<{ status: string }>("SELECT status FROM flaw.user_keys WHERE id = $1", [activeId]);
    expect(frozen.rows[0]?.status).toBe("revoked");
    expect(resolvedDek("revoked", activeDek)).toBeUndefined();
    expect(resolvedDek("retired", retiredDek)).toBe(retiredDek);
    expect(log).toContain("admin.revoke_dek");
    const audits = await listAuditEvents(pool, created.userId);
    expect(audits.map((row) => row.event_type)).toContain("admin.revoke_dek");
    expect(() =>
      openContent(
        { ownerId: created.userId, rowId: activeId, column: COLUMN.secretCt },
        sealed,
        () => resolvedDek("revoked", activeDek),
      ),
    ).toThrow(CryptoError);
    retiredDek.fill(0);
    activeDek.fill(0);
  });

  dbTest("un DELETE JSON à corps vide authentifié n'est pas un 400", async () => {
    const session = await provisionalSession();
    const changed = await changePassword(session.app, session.cookie, session.password, NEW_PASSWORD);
    expect(changed.statusCode).toBe(200);
    const cookie = cookiePair(setCookie(changed.headers));
    const enrolled = await enroll(session.app, cookie);
    expect(enrolled.statusCode).toBe(200);
    const secret = (enrolled.json() as { secret: string }).secret;
    const confirmed = await verify(session.app, cookie, totpAt(secret, now()));
    expect(confirmed.statusCode).toBe(200);
    const full = cookiePair(setCookie(confirmed.headers));
    const active = await findActiveUserKey(pool, session.userId);
    if (active === null) {
      throw new Error("dek absente");
    }
    const docId = randomUUID();
    await withOwner(pool, session.userId, async (sql) => {
      await sql.query(
        `INSERT INTO flaw.documents (
           id, owner_id, mode, format, font, projection_ct, projection_nonce, key_id, enc_version
         ) VALUES ($1, $2, 'prose', 'plain', 'serif', $3, $4, $5, 1)`,
        [docId, session.userId, Buffer.from([1]), Buffer.from([2]), active.id],
      );
    });
    const removed = await session.app.inject({
      method: "DELETE",
      url: `/api/v1/documents/${docId}`,
      headers: { "content-type": "application/json", origin: ORIGIN, cookie: full },
      payload: "",
    });
    expect(removed.statusCode).toBe(204);
  });

  dbTest("l'inscription reste 404 et l'oubli de mot de passe ne révèle aucun courriel (SEC-AUTH-03, AC-032)", async () => {
    const app = track(buildApp(config(), appOptions()));
    const signup = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up",
      headers: { "content-type": "application/json", origin: ORIGIN },
      payload: "{}",
    });
    expect(signup.statusCode).toBe(404);
    const forgot = await app.inject({
      method: "POST",
      url: "/api/auth/forget-password",
      headers: { "content-type": "application/json", origin: ORIGIN },
      payload: JSON.stringify({ identifier: "personne@box.invalid" }),
    });
    expect(forgot.statusCode).toBe(200);
    expect(forgot.json()).toEqual({ message: FORGOT_MESSAGE });
    expect(JSON.stringify(forgot.json())).not.toMatch(/@|mailto:/i);
  });

  dbTest("la consommation d'un code de secours est atomique (AC-066, négatif)", async () => {
    const ready = await readyToEnroll();
    const enrolled = await enroll(ready.app, ready.cookie);
    expect(enrolled.statusCode).toBe(200);
    const code = (enrolled.json() as { codes: string[] }).codes[0] ?? "";
    const pepper = decodeValidatedKey(secrets.recoveryPepper);
    if (pepper === null) {
      throw new Error("poivre");
    }
    const mac = recoveryCodeHmac(pepper, PEPPER_ID, ready.userId, code);
    if (mac === null) {
      throw new Error("hmac");
    }
    const [first, second] = await Promise.all([
      consumeRecoveryCode(pool, ready.userId, mac, now()),
      consumeRecoveryCode(pool, ready.userId, mac, now()),
    ]);
    expect([first, second].filter((value) => value === true)).toHaveLength(1);
    await expect(insertRecoveryCode(pool, ready.userId, PEPPER_ID, mac)).rejects.toThrow();
  });

  dbTest("create-user puis changement de mot de passe sans enrôlement ne donne pas une session complète (M1)", async () => {
    const email = nextEmail();
    const ready = await readyToEnroll(email);
    const signed = await sign(ready.app, email, NEW_PASSWORD);
    expect(signed.statusCode).toBe(200);
    const cookie = cookiePair(setCookie(signed.headers));
    expect((await authed(ready.app, "GET", "/api/v1/documents", cookie)).statusCode).toBe(403);
    const enrolled = await enroll(ready.app, cookie);
    expect(enrolled.statusCode).toBe(200);
    const again = await sign(ready.app, email, NEW_PASSWORD);
    expect(again.statusCode).toBe(200);
    expect((await authed(ready.app, "GET", "/api/v1/documents", cookiePair(setCookie(again.headers)))).statusCode).toBe(403);
    clock.ms += 24 * 60 * 60 * 1000;
    const refused = await sign(ready.app, email, NEW_PASSWORD);
    expect(refused.statusCode).toBe(401);
  });

  dbTest("mfa/verify est limité comme la connexion et répond 429 (Q-015, SEC-AUTH-03)", async () => {
    const email = nextEmail();
    const ready = await readyToEnroll(email);
    const enrolled = await enroll(ready.app, ready.cookie);
    expect(enrolled.statusCode).toBe(200);
    const secret = (enrolled.json() as { secret: string }).secret;
    let limited = await verify(ready.app, ready.cookie, "000000");
    for (let attempt = 0; attempt < 300; attempt += 1) {
      limited = await verify(ready.app, ready.cookie, "000000");
    }
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["content-type"]).toContain("application/problem+json");
    expect(limited.json()).toEqual(problem(429, TOO_MANY));
    expect(limited.headers["retry-after"]).toBeDefined();
    const late = await verify(ready.app, ready.cookie, totpAt(secret, now()));
    expect(late.statusCode).toBe(429);
    expect(late.json()).toEqual(problem(429, TOO_MANY));
    const signed = await sign(ready.app, email, NEW_PASSWORD);
    expect(signed.statusCode).toBe(429);
    expect(signed.json()).toEqual(problem(429, TOO_MANY));
  }, 120_000);

  dbTest("le même pas TOTP envoyé en parallèle n'est accepté qu'une fois (Q-015)", async () => {
    const identifier = randomBytes(32).toString("hex");
    const expires = new Date(now().getTime() + 60_000);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => claimTotpStep(pool, identifier, 1000, expires)),
    );
    expect(results.filter((value) => value === true)).toHaveLength(1);
  });

  dbTest("reset-password annule tout si le provisoire est refusé (m6)", async () => {
    const email = nextEmail();
    const ready = await readyToEnroll(email);
    await expect(floorAuth().resetPassword(email, nextIp(), "court")).rejects.toThrow(/mot de passe refusé/);
    expect((await authed(ready.app, "GET", "/api/v1/documents", ready.cookie)).statusCode).toBe(403);
    const signed = await sign(ready.app, email, NEW_PASSWORD);
    expect(signed.statusCode).toBe(200);
  });

  dbTest("une DEK revoked rend la connexion impossible et prévient l'exploitant (Q-015)", async () => {
    const email = nextEmail();
    const ready = await readyToEnroll(email);
    const enrolled = await enroll(ready.app, ready.cookie);
    expect(enrolled.statusCode).toBe(200);
    const secret = (enrolled.json() as { secret: string }).secret;
    const confirmed = await verify(ready.app, ready.cookie, totpAt(secret, now()));
    expect(confirmed.statusCode).toBe(200);
    const devicePair = cookiePair(deviceSetCookie(confirmed.headers));
    await pool.query("UPDATE flaw.user_keys SET status = 'revoked' WHERE owner_id = $1", [ready.userId]);
    let log = "";
    const stream = new PassThrough();
    stream.on("data", (chunk: Buffer) => {
      log += chunk.toString("utf8");
    });
    const app = track(buildApp(config(), { ...appOptions(), logStream: stream }));
    const plain = await sign(app, email, NEW_PASSWORD, { ua: CHROME });
    const withCode = await sign(app, email, NEW_PASSWORD, { ua: CHROME, totp: totpAt(secret, now(), 1) });
    const withDevice = await sign(app, email, NEW_PASSWORD, { ua: CHROME, cookie: devicePair });
    for (const response of [plain, withCode, withDevice]) {
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual(problem(401));
      expect(JSON.stringify(response.json())).not.toMatch(/revoked|révoqu|dek/i);
    }
    expect(log).toContain("admin.dek_revoked");
    const audits = await listAuditEvents(pool, ready.userId);
    expect(audits.map((row) => row.event_type)).toContain("admin.dek_revoked");
  });

  dbTest("create-user n'inscrit rien si le provisoire est refusé (m6)", async () => {
    const before = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM flaw.users");
    await expect(floorAuth().createUser(nextEmail(), nextIp(), "court")).rejects.toThrow(/mot de passe refusé/);
    const after = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM flaw.users");
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });

  dbTest("revoke-dek révoque la DEK depuis la CLI (m2)", async () => {
    const email = nextEmail();
    const created = await floorAuth().createUser(email, nextIp());
    const dekId = randomUUID();
    await insertUserKey(pool, {
      id: dekId,
      userId: created.userId,
      wrappedCt: randomBytes(8),
      wrappedNonce: randomBytes(8),
      kekId: KEK_ID,
      encVersion: 1,
    });
    const result = await run(["revoke-dek", "--email", email, "--dek-id", dekId]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("dek révoquée");
    expect(result.stderr).toContain("admin.revoke_dek");
    const status = await pool.query<{ status: string }>("SELECT status FROM flaw.user_keys WHERE id = $1", [dekId]);
    expect(status.rows[0]?.status).toBe("revoked");
    expect(alerts).toContain("admin.revoke_dek");
  });

  dbTest("une DEK revoked ne peut pas être supprimée puis réinsérée (m2)", async () => {
    const created = await floorAuth().createUser(nextEmail(), nextIp());
    const dekId = randomUUID();
    await pool.query(
      `INSERT INTO flaw.user_keys (id, owner_id, wrapped_ct, wrapped_nonce, key_id, enc_version, status)
       VALUES ($1, $2, $3, $4, $5, 1, 'active')`,
      [dekId, created.userId, randomBytes(8), randomBytes(8), KEK_ID],
    );
    await pool.query("UPDATE flaw.user_keys SET status = 'revoked' WHERE id = $1", [dekId]);
    await expect(pool.query("DELETE FROM flaw.user_keys WHERE id = $1", [dekId])).rejects.toThrow(/dek revoked/);
    await expect(
      pool.query(
        `INSERT INTO flaw.user_keys (id, owner_id, wrapped_ct, wrapped_nonce, key_id, enc_version, status)
         VALUES ($1, $2, $3, $4, $5, 1, 'active')`,
        [dekId, created.userId, randomBytes(8), randomBytes(8), KEK_ID],
      ),
    ).rejects.toThrow(/dek revoked/);
    const row = await pool.query<{ status: string }>("SELECT status FROM flaw.user_keys WHERE id = $1", [dekId]);
    expect(row.rows[0]?.status).toBe("revoked");
  });

  dbTest("un échec de commande écrit l'audit (f6)", async () => {
    const created = await floorAuth().createUser(nextEmail(), nextIp());
    const failed = await run(["replay-erasures"]);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("admin.replay_erasures");
    const audits = await listAuditEvents(pool, created.userId);
    expect(audits.some((row) => row.event_type === "admin.replay_erasures" && row.result === "erreur")).toBe(true);
  });

  dbTest("mfa/verify journalise l'adresse du client (SEC-LOG-08)", async () => {
    const email = nextEmail();
    const ready = await readyToEnroll(email);
    const enrolled = await enroll(ready.app, ready.cookie);
    expect(enrolled.statusCode).toBe(200);
    const secret = (enrolled.json() as { secret: string }).secret;
    let log = "";
    const stream = new PassThrough();
    stream.on("data", (chunk: Buffer) => {
      log += chunk.toString("utf8");
    });
    const app = track(buildApp(config(), { ...appOptions(), logStream: stream }));
    const signed = await sign(app, email, NEW_PASSWORD);
    expect(signed.statusCode).toBe(200);
    const mark = log.length;
    const confirmed = await app.inject({
      method: "POST",
      url: "/api/auth/mfa/verify",
      remoteAddress: "172.31.250.10",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        cookie: cookiePair(setCookie(signed.headers)),
        "user-agent": CHROME,
        "x-real-ip": "203.0.113.44",
      },
      payload: JSON.stringify({ code: totpAt(secret, now()) }),
    });
    expect(confirmed.statusCode).toBe(200);
    const slice = log.slice(mark);
    expect(slice).toContain("203.0.113.44");
    expect(slice).toContain("login_success");
    expect(slice).toContain("session_created");
    expect(slice).not.toContain("127.0.0.1");
  });
});
