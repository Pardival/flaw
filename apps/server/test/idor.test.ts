/**
 * T-011 — can(), couche d'accès et anti-IDOR à deux comptes (AC-101, SEC-API-02, SEC-DATA-01).
 * Postgres 18.6 épinglé, même image que T-005.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ACCESS_DENIED,
  ACCESS_GRANTED,
  DOCUMENT_ACTIONS,
  can,
  exportDocument,
  listOwnedDocuments,
  patchDocument,
  readDocument,
  syncDocument,
  updateDocument,
  withActor,
  type AccessActor,
  type DocumentAction,
} from "../src/access/index.ts";
import { buildApp } from "../src/app.ts";
import { newSessionToken, SESSION_COOKIE } from "../src/auth/cookie.ts";
import type { AppConfig } from "../src/config/load.ts";
import type { LoadedSecrets } from "../src/config/secrets.ts";
import { applyMigrations, assertAppRole } from "../src/db/migrate.ts";
import { validateKeyMaterial } from "../src/platform/healthz.ts";
import { problem } from "../src/platform/problem.ts";
import { SCHEMA_VERSION } from "@flaw/schema/src/index.ts";

const POSTGRES_IMAGE =
  "postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873";
const DB_PASSWORD = "0123456789abcdef0123456789abcdef";
const HEX = "0123456789abcdef0123456789abcdef";
const ORIGIN = "https://flaw.test";
const MISSING = "00000000-0000-4000-8000-000000000099";
const TRACKERS = ["google-analytics", "googletagmanager", "segment.io", "plausible.io", "doubleclick.net"];
const PASSWORD_HASH = "$argon2id$v=19$m=65536$c2FsdA$aGFzaA";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const accessDir = join(root, "apps/server/src/access");
const dbTestsLabel = basename(fileURLToPath(import.meta.url));
const container = `flaw-t011-idor-${process.pid}`;

type Method = "GET" | "PUT" | "PATCH" | "DELETE" | "POST";

const ATTACKS: Array<{ method: Method; url: (id: string) => string; payload?: string }> = [
  { method: "GET", url: (id) => `/api/v1/documents/${id}` },
  { method: "PUT", url: (id) => `/api/v1/documents/${id}`, payload: JSON.stringify({ font: "sans" }) },
  { method: "PATCH", url: (id) => `/api/v1/documents/${id}`, payload: JSON.stringify({ font: "sans" }) },
  { method: "POST", url: (id) => `/api/v1/documents/${id}/sync`, payload: "{}" },
  { method: "POST", url: (id) => `/api/v1/documents/${id}/export`, payload: "{}" },
  { method: "DELETE", url: (id) => `/api/v1/documents/${id}`, payload: "{}" },
];

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

function config(): AppConfig {
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
  };
}

function walkTs(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTs(path));
      continue;
    }
    if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(path);
    }
  }
  return files;
}

describe("can() hors base", () => {
  it("est la seule autorisation et n'écrit pas de SQL sans owner_id", () => {
    const serverRoot = join(root, "apps/server/src");
    const definitions = walkTs(serverRoot).filter((path) =>
      /(?:export\s+)?(?:async\s+)?function can\b/.test(readFileSync(path, "utf8")),
    );
    expect(definitions).toEqual([join(accessDir, "can.ts")]);
    const accessSource = walkTs(accessDir).map((path) => readFileSync(path, "utf8")).join("\n");
    expect(accessSource).not.toContain("BYPASSRLS");
    for (const host of TRACKERS) {
      expect(accessSource).not.toContain(host);
    }
    const queries = [...accessSource.matchAll(/"([^"\n]*flaw\.documents[^"\n]*)"/g)].map((match) => match[1] ?? "");
    expect(queries.length).toBeGreaterThan(0);
    for (const query of queries) {
      expect(query).toContain("owner_id");
    }
    const rest = readFileSync(join(accessDir, "rest.ts"), "utf8");
    const routes = readFileSync(join(serverRoot, "auth/routes.ts"), "utf8");
    const store = readFileSync(join(serverRoot, "auth/store.ts"), "utf8");
    expect(rest).not.toContain("flaw.documents");
    expect(routes).not.toContain("flaw.documents");
    expect(routes).toContain("registerContentRoutes");
    expect(store).not.toContain("flaw.documents");
    expect(store).toContain("listOwnedDocuments");
    expect(readFileSync(join(accessDir, "sync.ts"), "utf8")).toContain("can(");
    expect(readFileSync(join(accessDir, "documents.ts"), "utf8")).toContain("can(");
  });

  it("renvoie le même refus sans interroger pour un acteur illisible", async () => {
    let queries = 0;
    const sql = {
      async query(): Promise<{ rows: Array<{ id: string }>; rowCount: number }> {
        queries += 1;
        return { rows: [], rowCount: 0 };
      },
    };
    const actor = { userId: "pas-un-uuid", role: "admin" as const };
    const missing = await can(sql, actor, "read", { type: "document", id: MISSING });
    const foreign = await can(sql, actor, "delete", { type: "document", id: MISSING });
    expect(missing).toBe(ACCESS_DENIED);
    expect(foreign).toBe(missing);
    expect(Object.keys(missing)).toEqual(["ok"]);
    expect(queries).toBe(0);
    const listed = await can(sql, { userId: MISSING, role: "admin" }, "read", { type: "documents" });
    expect(listed).toBe(ACCESS_GRANTED);
    expect(queries).toBe(0);
    const unknown = await can(sql, { userId: MISSING, role: "user" }, "drop" as DocumentAction, {
      type: "document",
      id: MISSING,
    });
    expect(unknown).toBe(ACCESS_DENIED);
    expect(queries).toBe(0);
  });
});

describe("anti-IDOR sur PostgreSQL", () => {
  let owner: Client;
  let appClient: Client;
  let pool: Pool;
  let port = 0;
  let secretDir = "";
  let app: ReturnType<typeof buildApp>;
  let userN = 0;
  let dbTests = 0;

  const secrets = {
    databasePassword: DB_PASSWORD,
    betterAuthSecret: HEX,
    kek: "",
    recoveryPepper: "",
    hmacPepper: "",
  } as LoadedSecrets;

  function dbTest(name: string, fn: () => Promise<void>): void {
    it(name, async () => {
      dbTests += 1;
      await fn();
    }, 60_000);
  }

  async function call(method: Method, url: string, cookie?: string, payload?: string) {
    const mutating = method !== "GET";
    return app.inject({
      method,
      url,
      remoteAddress: "172.31.250.10",
      headers: {
        ...(cookie === undefined ? {} : { cookie }),
        ...(mutating ? { origin: ORIGIN, "content-type": "application/json" } : {}),
      },
      ...(mutating ? { payload: payload ?? "{}" } : {}),
    });
  }

  function signature(response: { statusCode: number; body: string; headers: Record<string, unknown> }) {
    return {
      statusCode: response.statusCode,
      body: response.body,
      type: response.headers["content-type"],
      cache: response.headers["cache-control"],
    };
  }

  async function createAccount(role: "user" | "admin"): Promise<AccessActor & { cookie: string; dekId: string }> {
    userN += 1;
    const inserted = await pool.query<{ id: string }>("INSERT INTO flaw.users (role) VALUES ($1) RETURNING id", [role]);
    const userId = inserted.rows[0]?.id;
    if (userId === undefined) {
      throw new Error("utilisateur absent");
    }
    await pool.query(
      "INSERT INTO flaw.accounts (owner_id, provider_id, account_id, password_hash) VALUES ($1, 'credential', $2, $3)",
      [userId, `idor${userN}@box.invalid`, PASSWORD_HASH],
    );
    const dekId = randomUUID();
    await pool.query(
      `INSERT INTO flaw.user_keys (id, owner_id, wrapped_ct, wrapped_nonce, key_id, enc_version, status)
       VALUES ($1, $2, $3, $4, 'kek-2026-10', 1, 'active')`,
      [dekId, userId, Buffer.from([1]), Buffer.from([2])],
    );
    const issued = newSessionToken();
    const now = new Date();
    const idle = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const absolute = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO flaw.sessions (
         owner_id, token_hash, expires_at, created_at, last_activity_at,
         absolute_expires_at, browser, os, remember, restricted, reauthenticated_at
       ) VALUES ($1, $2, $3, $4, $4, $5, 'inconnu', 'inconnu', true, false, $4)`,
      [userId, issued.hash, idle, now, absolute],
    );
    return { userId, role, cookie: `${SESSION_COOKIE}=${issued.token}`, dekId };
  }

  async function insertDocument(actor: AccessActor, dekId: string, createdAt: Date): Promise<string> {
    const id = randomUUID();
    await withActor(pool, actor.userId, async (sql) => {
      await sql.query(
        `INSERT INTO flaw.documents (
           id, owner_id, mode, format, font, projection_ct, projection_nonce, key_id, enc_version, created_at, updated_at
         ) VALUES ($1, $2, 'prose', 'plain', 'serif', $3, $4, $5, 1, $6, $6)`,
        [id, actor.userId, Buffer.from([1]), Buffer.from([2]), dekId, createdAt],
      );
    });
    return id;
  }

  async function stored(actor: AccessActor, documentId: string) {
    return withActor(pool, actor.userId, async (sql) => {
      const result = await sql.query<{ font: string; owner_id: string; projection_ct: Buffer }>(
        "SELECT font, owner_id, projection_ct FROM flaw.documents WHERE id = $1 AND owner_id = $2",
        [documentId, actor.userId],
      );
      const updates = await sql.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM flaw.document_updates WHERE document_id = $1 AND owner_id = $2",
        [documentId, actor.userId],
      );
      return { row: result.rows[0] ?? null, updates: updates.rows[0]?.n ?? 0 };
    });
  }

  beforeAll(async () => {
    secrets.kek = validKey();
    secrets.recoveryPepper = validKey();
    secrets.hmacPepper = validKey();
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
    secretDir = mkdtempSync(join(tmpdir(), "flaw-t011-secrets-"));
    writeFileSync(join(secretDir, "app_db_password"), DB_PASSWORD);
    writeFileSync(join(secretDir, "db_owner_password"), DB_PASSWORD);
    chmodSync(join(secretDir, "app_db_password"), 0o600);
    chmodSync(join(secretDir, "db_owner_password"), 0o600);
    expect(docker(["exec", container, "mkdir", "-p", "/run/secrets", "/tmp/initdb"]).status).toBe(0);
    for (const name of ["app_db_password", "db_owner_password"]) {
      expect(docker(["cp", join(secretDir, name), `${container}:/run/secrets/${name}`]).status).toBe(0);
    }
    expect(
      docker(["cp", join(root, "infra/initdb/01-role-applicatif.sh"), `${container}:/tmp/initdb/01-role-applicatif.sh`])
        .status,
    ).toBe(0);
    expect(
      docker(["cp", join(root, "infra/initdb/secret-valide.inc"), `${container}:/tmp/initdb/secret-valide.inc`]).status,
    ).toBe(0);
    expect(
      docker([
        "exec",
        "-u",
        "root",
        container,
        "chown",
        "70:70",
        "/run/secrets/app_db_password",
        "/run/secrets/db_owner_password",
      ]).status,
    ).toBe(0);
    expect(
      docker([
        "exec",
        "-u",
        "root",
        container,
        "chmod",
        "440",
        "/run/secrets/app_db_password",
        "/run/secrets/db_owner_password",
      ]).status,
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
    app = buildApp(config(), { pool, secrets });
  }, 180_000);

  afterAll(async () => {
    process.stdout.write(`DB_TESTS_EXECUTED[${dbTestsLabel}]=${dbTests}\n`);
    await app?.close().catch(() => undefined);
    await pool?.end().catch(() => undefined);
    await appClient?.end().catch(() => undefined);
    await owner?.end().catch(() => undefined);
    if (secretDir !== "") {
      rmSync(secretDir, { recursive: true, force: true });
    }
    docker(["rm", "-fv", container]);
  });

  dbTest("refuse les textes sans session, en problem+json no-store (AC-030, SEC-API-01)", async () => {
    const listed = await call("GET", "/api/v1/documents");
    expect(listed.statusCode).toBe(401);
    expect(listed.headers["content-type"]).toContain("application/problem+json");
    expect(listed.headers["cache-control"]).toBe("no-store");
    expect(listed.json()).toEqual(problem(401));
    for (const attack of ATTACKS) {
      const response = await call(attack.method, attack.url(MISSING), undefined, attack.payload);
      expect(response.statusCode, attack.method).toBe(401);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toEqual(problem(401));
    }
  });

  dbTest("la liste de B ne contient aucun texte de A (AC-101, SEC-DATA-01)", async () => {
    const userA = await createAccount("user");
    const userB = await createAccount("user");
    const first = await insertDocument(userA, userA.dekId, new Date("2026-01-01T00:00:00.000Z"));
    const second = await insertDocument(userA, userA.dekId, new Date("2026-01-02T00:00:00.000Z"));
    const own = await insertDocument(userB, userB.dekId, new Date("2026-01-03T00:00:00.000Z"));
    const listA = await call("GET", "/api/v1/documents", userA.cookie);
    const listB = await call("GET", "/api/v1/documents", userB.cookie);
    expect(listA.statusCode).toBe(200);
    expect(listB.statusCode).toBe(200);
    expect(listA.headers["cache-control"]).toBe("no-store");
    expect(listA.json()).toMatchObject({ items: [{ id: second }, { id: first }], nextCursor: null });
    expect(listB.json()).toMatchObject({ items: [{ id: own }], nextCursor: null });
    const viaLayer = await listOwnedDocuments(pool, { userId: userB.userId, role: "user" });
    expect(viaLayer).toEqual([own]);
  });

  dbTest("B reçoit le même 404 que pour un texte absent (SEC-API-02, AC-101)", async () => {
    const userA = await createAccount("user");
    const userB = await createAccount("user");
    const documentA = await insertDocument(userA, userA.dekId, new Date("2026-02-01T00:00:00.000Z"));
    const before = await stored(userA, documentA);
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      calls.push(String(input));
      return original(input, init);
    }) as typeof fetch;
    try {
      for (const attack of ATTACKS) {
        const foreign = await call(attack.method, attack.url(documentA), userB.cookie, attack.payload);
        const missing = await call(attack.method, attack.url(MISSING), userB.cookie, attack.payload);
        expect(foreign.statusCode, attack.method).toBe(404);
        expect(foreign.json()).toEqual(problem(404));
        expect(foreign.headers["content-type"]).toContain("application/problem+json");
        expect(foreign.headers["cache-control"]).toBe("no-store");
        expect(signature(foreign)).toEqual(signature(missing));
        expect(foreign.body).not.toContain(documentA);
        expect(foreign.body.toLowerCase()).not.toContain("forbidden");
        expect(foreign.body.toLowerCase()).not.toContain("existe");
      }
      const invalid = await call("GET", "/api/v1/documents/pas-un-uuid", userB.cookie);
      const absent = await call("GET", `/api/v1/documents/${MISSING}`, userB.cookie);
      expect(signature(invalid)).toEqual(signature(absent));
    } finally {
      globalThis.fetch = original;
    }
    expect(calls).toEqual([]);
    const after = await stored(userA, documentA);
    expect(after.row?.font).toBe("serif");
    expect(after.row?.owner_id).toBe(userA.userId);
    expect(Buffer.from(after.row?.projection_ct ?? []).equals(Buffer.from([1]))).toBe(true);
    expect(after.updates).toBe(0);
    expect(before.row?.font).toBe(after.row?.font);
    for (const action of DOCUMENT_ACTIONS) {
      const foreign = await withActor(pool, userB.userId, (sql) =>
        can(sql, userB, action, { type: "document", id: documentA }),
      );
      const missing = await withActor(pool, userB.userId, (sql) =>
        can(sql, userB, action, { type: "document", id: MISSING }),
      );
      expect(foreign, action).toBe(ACCESS_DENIED);
      expect(missing, action).toBe(ACCESS_DENIED);
    }
  });

  dbTest("le propriétaire lit, modifie, synchronise et supprime son texte", async () => {
    const userA = await createAccount("user");
    const documentA = await insertDocument(userA, userA.dekId, new Date("2026-03-01T00:00:00.000Z"));
    const read = await call("GET", `/api/v1/documents/${documentA}`, userA.cookie);
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ id: documentA, fontFamily: "serif" });
    expect(read.headers["cache-control"]).toBe("no-store");
    const put = await call("PUT", `/api/v1/documents/${documentA}`, userA.cookie, JSON.stringify({ font: "sans" }));
    expect(put.statusCode).toBe(404);
    expect(put.headers["cache-control"]).toBe("no-store");
    expect((await stored(userA, documentA)).row?.font).toBe("serif");
    const patch = await call(
      "PATCH",
      `/api/v1/documents/${documentA}`,
      userA.cookie,
      JSON.stringify({ fontFamily: "mono" }),
    );
    expect(patch.statusCode).toBe(200);
    expect((await stored(userA, documentA)).row?.font).toBe("mono");
    const sync = await app.inject({
      method: "POST",
      url: `/api/v1/documents/${documentA}/sync`,
      remoteAddress: "172.31.250.10",
      headers: {
        cookie: userA.cookie,
        origin: ORIGIN,
        "content-type": "application/json",
        "x-flaw-schema-version": String(SCHEMA_VERSION),
      },
      payload: "{}",
    });
    expect(sync.statusCode).toBe(200);
    expect((await stored(userA, documentA)).updates).toBe(0);
    const exported = await call("POST", `/api/v1/documents/${documentA}/export`, userA.cookie, "{}");
    expect(exported.statusCode).toBe(404);
    expect(await exportDocument(pool, userA, documentA)).toBe(ACCESS_GRANTED);
    expect(await syncDocument(pool, userA, documentA)).toBe(ACCESS_GRANTED);
    const removed = await call("DELETE", `/api/v1/documents/${documentA}?permanent=true`, userA.cookie, "{}");
    expect(removed.statusCode).toBe(204);
    const gone = await call("GET", `/api/v1/documents/${documentA}`, userA.cookie);
    const missing = await call("GET", `/api/v1/documents/${MISSING}`, userA.cookie);
    expect(gone.statusCode).toBe(404);
    expect(signature(gone)).toEqual(signature(missing));
    expect((await stored(userA, documentA)).row).toBeNull();
  });

  dbTest("un admin ne lit pas le texte d'un autre compte (A-014)", async () => {
    const userA = await createAccount("user");
    const admin = await createAccount("admin");
    const documentA = await insertDocument(userA, userA.dekId, new Date("2026-04-01T00:00:00.000Z"));
    const own = await insertDocument(admin, admin.dekId, new Date("2026-04-02T00:00:00.000Z"));
    for (const action of DOCUMENT_ACTIONS) {
      const foreign = await withActor(pool, admin.userId, (sql) =>
        can(sql, admin, action, { type: "document", id: documentA }),
      );
      const missing = await withActor(pool, admin.userId, (sql) =>
        can(sql, admin, action, { type: "document", id: MISSING }),
      );
      expect(foreign, action).toBe(ACCESS_DENIED);
      expect(missing, action).toBe(ACCESS_DENIED);
    }
    expect(await readDocument(pool, admin, own)).toEqual({ ok: true, id: own });
    expect(await readDocument(pool, admin, documentA)).toBe(ACCESS_DENIED);
    const list = await call("GET", "/api/v1/documents", admin.cookie);
    expect(list.json()).toMatchObject({ items: [{ id: own }], nextCursor: null });
    for (const attack of ATTACKS) {
      const foreign = await call(attack.method, attack.url(documentA), admin.cookie, attack.payload);
      const missing = await call(attack.method, attack.url(MISSING), admin.cookie, attack.payload);
      expect(foreign.statusCode, attack.method).toBe(404);
      expect(signature(foreign)).toEqual(signature(missing));
    }
    expect((await stored(userA, documentA)).row?.font).toBe("serif");
  });

  dbTest("ignore l'owner_id du client et n'écrit pas la ligne d'un autre (SEC-DATA-01)", async () => {
    const userA = await createAccount("user");
    const userB = await createAccount("user");
    const documentA = await insertDocument(userA, userA.dekId, new Date("2026-05-01T00:00:00.000Z"));
    const forged = JSON.stringify({ fontFamily: "sans", owner_id: userA.userId, id: userB.userId });
    const denied = await call("PATCH", `/api/v1/documents/${documentA}`, userB.cookie, forged);
    expect(denied.statusCode).toBe(404);
    expect(denied.json()).toEqual(problem(404));
    expect(await patchDocument(pool, userB, documentA, "sans")).toBe(ACCESS_DENIED);
    expect(await updateDocument(pool, userB, documentA, "sans")).toBe(ACCESS_DENIED);
    expect((await stored(userA, documentA)).row).toMatchObject({ font: "serif", owner_id: userA.userId });
    const accepted = await call(
      "PATCH",
      `/api/v1/documents/${documentA}`,
      userA.cookie,
      JSON.stringify({ fontFamily: "sans", owner_id: userB.userId, id: MISSING }),
    );
    expect(accepted.statusCode).toBe(200);
    const after = await stored(userA, documentA);
    expect(after.row?.font).toBe("sans");
    expect(after.row?.owner_id).toBe(userA.userId);
    const still = await call("GET", `/api/v1/documents/${documentA}`, userA.cookie);
    expect(still.json()).toMatchObject({ id: documentA, fontFamily: "sans" });
  });
});
