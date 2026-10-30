/**
 * API REST des textes (T-018, API-009 à API-015, SEC-API-01/02, SEC-DATA-05).
 * Postgres 18.6 épinglé, même image que T-005.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateDek, wrapDek } from "@flaw/crypto";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withActor } from "../access/scope.ts";
import { buildApp } from "../app.ts";
import { newSessionToken, SESSION_COOKIE } from "../auth/cookie.ts";
import type { AppConfig } from "../config/load.ts";
import type { LoadedSecrets } from "../config/secrets.ts";
import { decodeValidatedKey } from "../crypto/kek.ts";
import { applyMigrations, assertAppRole } from "../db/migrate.ts";
import { validateKeyMaterial } from "../platform/healthz.ts";
import { problem } from "../platform/problem.ts";
import { decodeSyncRequest, encodeSyncReply } from "../../../../packages/sync/src/index.ts";
import { titledDocument } from "./prose.ts";

const POSTGRES_IMAGE =
  "postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873";
const DB_PASSWORD = "0123456789abcdef0123456789abcdef";
const HEX = "0123456789abcdef0123456789abcdef";
const ORIGIN = "https://flaw.test";
const MISSING = "00000000-0000-4000-8000-000000000099";
const PASSWORD_HASH = "$argon2id$v=19$m=65536$c2FsdA$aGFzaA";
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const openapiPath = join(root, "openapi.json");
const dbTestsLabel = basename(fileURLToPath(import.meta.url));
const container = `flaw-t018-docs-${process.pid}`;

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type DocumentBody = {
  id: string;
  title: string;
  mode: string;
  wordCount: number;
  updatedAt: string;
  deletedAt: string | null;
  excerpt: string;
  pageFormat: string;
  fontFamily: string;
  baseFontSizePt: number;
  schemaVersion: number;
  outline: Array<{ level: number; title: string }>;
  createdAt: string;
};
type ListBody = { items: DocumentBody[]; nextCursor: string | null };

function validKey(): string {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const encoded = randomBytes(32).toString("base64");
    if (validateKeyMaterial(`${encoded}\n`) === null) {
      return encoded;
    }
  }
  throw new Error("aucune clé de test");
}

function uuidV7(): string {
  const bytes = randomBytes(16);
  const ms = BigInt(Date.now());
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function operationCodes(document: { paths?: Record<string, unknown> }, operationId: string): string[] {
  for (const item of Object.values(document.paths ?? {})) {
    if (item === null || typeof item !== "object") {
      continue;
    }
    for (const operation of Object.values(item)) {
      if (operation === null || typeof operation !== "object" || !("operationId" in operation)) {
        continue;
      }
      if (operation.operationId !== operationId || !("responses" in operation)) {
        continue;
      }
      const responses = operation.responses;
      if (responses === null || typeof responses !== "object") {
        continue;
      }
      return Object.keys(responses).sort();
    }
  }
  throw new Error(operationId);
}

describe("contrat documents", () => {
  const document = JSON.parse(readFileSync(openapiPath, "utf8")) as { paths?: Record<string, unknown> };

  it("n'emploie plus le paramètre {id} et déclare les codes du contrat", () => {
    const text = readFileSync(openapiPath, "utf8");
    expect(text.includes("/documents/{id}")).toBe(false);
    expect(document.paths?.["/api/v1/documents/{documentId}"]).toBeDefined();
    expect(operationCodes(document, "listDocuments")).toEqual(["200"]);
    expect(operationCodes(document, "createDocument")).toEqual(["200", "201", "409", "422"]);
    expect(operationCodes(document, "getDocument")).toEqual(["200", "404"]);
    expect(operationCodes(document, "updateDocument")).toEqual(["200", "404"]);
    expect(operationCodes(document, "deleteDocument")).toEqual(["204", "404"]);
    expect(operationCodes(document, "restoreDocument")).toEqual(["200"]);
    expect(operationCodes(document, "getDocumentContent")).toEqual(["200"]);
    expect(operationCodes(document, "syncDocument")).toEqual(["200", "413", "426"]);
    expect(operationCodes(document, "listSessions")).toEqual(["200", "401"]);
    expect(operationCodes(document, "revokeSession")).toEqual(["204", "404"]);
    expect(operationCodes(document, "revokeOtherSessions")).toEqual(["204", "401", "403"]);
    expect(operationCodes(document, "health")).toEqual(["200"]);
    expect(text).not.toContain('"/api/v1/documents/{documentId}": {\n      "put"');
  });

  it("valide le document initial avec documentFromJson", () => {
    const novel = titledDocument("novel", "Bonjour");
    expect(novel.type.name).toBe("doc");
    expect(novel.child(0).type.name).toBe("title");
    expect(novel.child(0).textContent).toBe("Bonjour");
    const empty = titledDocument("blank", "");
    expect(empty.child(0).textContent).toBe("");
    const screenplay = titledDocument("screenplay", "INT. STUDIO");
    expect(screenplay.child(1).type.name).toBe("scene_heading");
  });
});

describe("documents sur PostgreSQL", () => {
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

  function docker(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync("docker", args, { encoding: "utf8" });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }

  async function call(
    method: Method,
    url: string,
    cookie?: string,
    payload?: string | Buffer,
    headers: Record<string, string> = {},
  ) {
    const mutating = method !== "GET";
    return app.inject({
      method,
      url,
      remoteAddress: "172.31.250.10",
      headers: {
        ...(cookie === undefined ? {} : { cookie }),
        ...(mutating ? { origin: ORIGIN, "content-type": "application/json" } : {}),
        ...headers,
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

  async function createAccount(role: "user" | "admin"): Promise<{ userId: string; role: "user" | "admin"; cookie: string }> {
    userN += 1;
    const inserted = await pool.query<{ id: string }>("INSERT INTO flaw.users (role) VALUES ($1) RETURNING id", [role]);
    const userId = inserted.rows[0]?.id;
    if (userId === undefined) {
      throw new Error("utilisateur absent");
    }
    await pool.query(
      "INSERT INTO flaw.accounts (owner_id, provider_id, account_id, password_hash) VALUES ($1, 'credential', $2, $3)",
      [userId, `t018-${userN}@box.invalid`, PASSWORD_HASH],
    );
    const kek = decodeValidatedKey(secrets.kek);
    if (kek === null) {
      throw new Error("kek");
    }
    const dek = generateDek();
    const wrapped = wrapDek(kek, "kek-2026-10", userId, dek);
    dek.fill(0);
    kek.fill(0);
    await pool.query(
      `INSERT INTO flaw.user_keys (id, owner_id, wrapped_ct, wrapped_nonce, key_id, enc_version, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'active')`,
      [
        randomUUID(),
        userId,
        Buffer.from(wrapped.wrappedCt),
        Buffer.from(wrapped.wrappedNonce),
        wrapped.keyId,
        wrapped.encVersion,
      ],
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
    return { userId, role, cookie: `${SESSION_COOKIE}=${issued.token}` };
  }

  async function createOwned(
    cookie: string,
    mode: "novel" | "screenplay" | "document" | "blank",
    title?: string,
  ): Promise<DocumentBody> {
    const id = uuidV7();
    const response = await call(
      "POST",
      "/api/v1/documents",
      cookie,
      JSON.stringify({ id, mode, ...(title === undefined ? {} : { title }) }),
    );
    expect(response.statusCode).toBe(201);
    return response.json() as DocumentBody;
  }

  async function setUpdated(userId: string, documentId: string, at: Date): Promise<void> {
    await withActor(pool, userId, (sql) =>
      sql.query("UPDATE flaw.documents SET updated_at = $3 WHERE id = $1 AND owner_id = $2", [documentId, userId, at]),
    );
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
    secretDir = mkdtempSync(join(tmpdir(), "flaw-t018-secrets-"));
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

  dbTest("crée un texte de façon idempotente et refuse l'identifiant d'un autre compte", async () => {
    const userA = await createAccount("user");
    const userB = await createAccount("user");
    const id = uuidV7();
    const created = await call(
      "POST",
      "/api/v1/documents",
      userA.cookie,
      JSON.stringify({ id, mode: "novel", title: "Chapitre", owner_id: userB.userId, importedFrom: "md" }),
      { "idempotency-key": "reprise-1" },
    );
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      id,
      title: "Chapitre",
      mode: "novel",
      pageFormat: "novel_13x20",
      fontFamily: "EB Garamond",
      baseFontSizePt: 11,
      schemaVersion: 1,
      wordCount: 0,
      deletedAt: null,
    });
    expect(created.json()).not.toHaveProperty("importedFrom");
    const replay = await call(
      "POST",
      "/api/v1/documents",
      userA.cookie,
      JSON.stringify({ id, mode: "document", title: "Autre" }),
    );
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ id, title: "Chapitre", mode: "novel" });
    const conflict = await call("POST", "/api/v1/documents", userB.cookie, JSON.stringify({ id, mode: "novel" }));
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ type: "about:blank", status: 409, title: "Conflit", code: "conflict" });
    const owned = await withActor(pool, userA.userId, (sql) =>
      sql.query<{ owner_id: string }>("SELECT owner_id FROM flaw.documents WHERE id = $1", [id]),
    );
    expect(owned.rows[0]?.owner_id).toBe(userA.userId);
    const bad = await call("POST", "/api/v1/documents", userA.cookie, JSON.stringify({ id: randomUUID(), mode: "novel" }));
    expect(bad.statusCode).toBe(422);
    const longKey = await call("POST", "/api/v1/documents", userA.cookie, JSON.stringify({ id: uuidV7(), mode: "blank" }), {
      "idempotency-key": "k".repeat(129),
    });
    expect(longKey.statusCode).toBe(422);
    const untitled = await createOwned(userA.cookie, "blank");
    expect(untitled.title).toBe("Sans titre");
    const blank = await createOwned(userA.cookie, "blank", "");
    expect(blank.title).toBe("");
    const script = await createOwned(userA.cookie, "screenplay", "INT. NUIT");
    expect(script).toMatchObject({ fontFamily: "Courier Prime", pageFormat: "us_letter", baseFontSizePt: 12 });
    const prose = await createOwned(userA.cookie, "document", "Note");
    expect(prose.pageFormat).toBe("a4");
  });

  dbTest("page la liste, la corbeille et updatedSince, et rejette une requête invalide", async () => {
    const user = await createAccount("user");
    const first = await createOwned(user.cookie, "novel", "Un");
    const second = await createOwned(user.cookie, "novel", "Deux");
    const third = await createOwned(user.cookie, "novel", "Trois");
    await setUpdated(user.userId, first.id, new Date("2026-06-01T00:00:00.000Z"));
    await setUpdated(user.userId, second.id, new Date("2026-06-02T00:00:00.000Z"));
    await setUpdated(user.userId, third.id, new Date("2026-06-03T00:00:00.000Z"));
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 4; page += 1) {
      const url = cursor === null ? "/api/v1/documents?limit=1" : `/api/v1/documents?limit=1&cursor=${encodeURIComponent(cursor)}`;
      const response = await call("GET", url, user.cookie);
      expect(response.statusCode).toBe(200);
      const body = response.json() as ListBody;
      if (body.items.length === 0) {
        expect(body.nextCursor).toBeNull();
        break;
      }
      expect(body.items).toHaveLength(1);
      seen.push(body.items[0]?.id ?? "");
      cursor = body.nextCursor;
      if (cursor === null) {
        break;
      }
    }
    expect(seen).toEqual([third.id, second.id, first.id]);
    const removed = await call("DELETE", `/api/v1/documents/${second.id}`, user.cookie);
    expect(removed.statusCode).toBe(204);
    const live = await call("GET", "/api/v1/documents", user.cookie);
    expect((live.json() as ListBody).items.map((item) => item.id)).toEqual([third.id, first.id]);
    const trash = await call("GET", "/api/v1/documents?trashed=true", user.cookie);
    const trashed = trash.json() as ListBody;
    expect(trashed.items.map((item) => item.id)).toEqual([second.id]);
    expect(trashed.items[0]?.deletedAt).not.toBeNull();
    const incremental = await call(
      "GET",
      "/api/v1/documents?updatedSince=2026-06-02T12:00:00.000Z",
      user.cookie,
    );
    const changed = (incremental.json() as ListBody).items.map((item) => item.id);
    expect(changed).toContain(second.id);
    expect(changed).not.toContain(first.id);
    for (const url of [
      "/api/v1/documents?limit=0",
      "/api/v1/documents?limit=201",
      "/api/v1/documents?trashed=oui",
      "/api/v1/documents?updatedSince=hier",
      "/api/v1/documents?inconnu=1",
      "/api/v1/documents?cursor=%%%",
    ]) {
      const invalid = await call("GET", url, user.cookie);
      expect(invalid.statusCode, url).toBe(422);
      expect(invalid.headers["content-type"]).toContain("application/problem+json");
    }
  });

  dbTest("chiffre le titre dans la projection et met à jour les métadonnées", async () => {
    const user = await createAccount("user");
    const title = "Titre-distinctif-T018-alpha-bravo-charlie";
    const created = await createOwned(user.cookie, "novel", "Brouillon");
    const patched = await call(
      "PATCH",
      `/api/v1/documents/${created.id}`,
      user.cookie,
      JSON.stringify({ title, pageFormat: "a5", fontFamily: "Courier Prime", baseFontSizePt: 14 }),
    );
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({
      title,
      pageFormat: "a5",
      fontFamily: "Courier Prime",
      baseFontSizePt: 14,
      excerpt: "",
      outline: [],
    });
    const read = await call("GET", `/api/v1/documents/${created.id}`, user.cookie);
    expect(read.statusCode).toBe(200);
    expect(read.headers.etag).toBe('"1"');
    const columns = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_schema = 'flaw' AND table_name = 'documents' AND column_name = 'title'`,
    );
    expect(columns.rows[0]?.n).toBe(0);
    const stored = await withActor(pool, user.userId, (sql) =>
      sql.query<{ projection_ct: Buffer; state_ct: Buffer; font: string; format: string }>(
        `SELECT d.projection_ct, s.state_ct, d.font, d.format
         FROM flaw.documents d
         JOIN flaw.document_states s ON s.document_id = d.id
         WHERE d.id = $1 AND d.owner_id = $2`,
        [created.id, user.userId],
      ),
    );
    const row = stored.rows[0];
    expect(row?.font).toBe("Courier Prime");
    expect(row?.format).toBe("a5");
    const needle = Buffer.from(title, "utf8");
    expect(row?.projection_ct.includes(needle)).toBe(false);
    expect(row?.state_ct.includes(needle)).toBe(false);
    const tiny = await call(
      "PATCH",
      `/api/v1/documents/${created.id}`,
      user.cookie,
      JSON.stringify({ baseFontSizePt: 5 }),
    );
    expect(tiny.statusCode).toBe(422);
    const emptyPatch = await call("PATCH", `/api/v1/documents/${created.id}`, user.cookie, "{}");
    expect(emptyPatch.statusCode).toBe(422);
  });

  dbTest("met à la corbeille, restaure, puis supprime définitivement", async () => {
    const user = await createAccount("user");
    const created = await createOwned(user.cookie, "novel", "A garder");
    const removed = await call("DELETE", `/api/v1/documents/${created.id}`, user.cookie);
    expect(removed.statusCode).toBe(204);
    const hidden = await call("GET", `/api/v1/documents/${created.id}`, user.cookie);
    expect(hidden.statusCode).toBe(200);
    expect((hidden.json() as DocumentBody).deletedAt).not.toBeNull();
    const restored = await call("POST", `/api/v1/documents/${created.id}/restore`, user.cookie, "{}");
    expect(restored.statusCode).toBe(200);
    expect((restored.json() as DocumentBody).deletedAt).toBeNull();
    expect((restored.json() as DocumentBody).title).toBe("A garder");
    const gone = await call("DELETE", `/api/v1/documents/${created.id}?permanent=true`, user.cookie);
    expect(gone.statusCode).toBe(204);
    const missing = await call("GET", `/api/v1/documents/${created.id}`, user.cookie);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual(problem(404));
    const count = await withActor(pool, user.userId, (sql) =>
      sql.query<{ n: number }>("SELECT count(*)::int AS n FROM flaw.documents WHERE id = $1", [created.id]),
    );
    expect(count.rows[0]?.n).toBe(0);
  });

  dbTest("relit le contenu en JSON, en texte et en markdown", async () => {
    const user = await createAccount("user");
    const created = await createOwned(user.cookie, "novel", "Lisible");
    const json = await call("GET", `/api/v1/documents/${created.id}/content`, user.cookie);
    expect(json.statusCode).toBe(200);
    expect(json.headers["content-type"]).toContain("application/json");
    expect(json.json()).toMatchObject({ type: "doc" });
    const text = await call("GET", `/api/v1/documents/${created.id}/content?format=text`, user.cookie);
    expect(text.statusCode).toBe(200);
    expect(text.headers["content-type"]).toContain("text/plain");
    expect(text.body).toContain("Lisible");
    const markdown = await call("GET", `/api/v1/documents/${created.id}/content?format=markdown`, user.cookie);
    expect(markdown.statusCode).toBe(200);
    expect(markdown.headers["content-type"]).toContain("text/markdown");
    expect(markdown.body).toContain("# Lisible");
    const bad = await call("GET", `/api/v1/documents/${created.id}/content?format=pdf`, user.cookie);
    expect(bad.statusCode).toBe(422);
  });

  dbTest("ne laisse pas B lire, lister, modifier, supprimer ni restaurer le texte de A", async () => {
    const userA = await createAccount("user");
    const userB = await createAccount("user");
    const title = "Secret-de-A-T018-ne-doit-pas-fuir";
    const created = await createOwned(userA.cookie, "novel", title);
    const listB = await call("GET", "/api/v1/documents", userB.cookie);
    expect(listB.statusCode).toBe(200);
    expect(JSON.stringify(listB.json())).not.toContain(created.id);
    expect(JSON.stringify(listB.json())).not.toContain(title);
    const attacks: Array<{ method: Method; url: string; payload?: string }> = [
      { method: "GET", url: `/api/v1/documents/${created.id}` },
      { method: "GET", url: `/api/v1/documents/${created.id}/content` },
      { method: "PATCH", url: `/api/v1/documents/${created.id}`, payload: JSON.stringify({ title: "Volé" }) },
      { method: "DELETE", url: `/api/v1/documents/${created.id}` },
      { method: "POST", url: `/api/v1/documents/${created.id}/restore`, payload: "{}" },
      { method: "POST", url: `/api/v1/documents/${created.id}/sync`, payload: "{}" },
    ];
    for (const attack of attacks) {
      const foreign = await call(attack.method, attack.url, userB.cookie, attack.payload);
      const missing = await call(attack.method, attack.url.replace(created.id, MISSING), userB.cookie, attack.payload);
      expect(foreign.statusCode, attack.method).toBe(404);
      expect(foreign.json()).toEqual(problem(404));
      expect(signature(foreign)).toEqual(signature(missing));
      expect(foreign.body).not.toContain(created.id);
      expect(foreign.body).not.toContain(title);
    }
    const still = await call("GET", `/api/v1/documents/${created.id}`, userA.cookie);
    expect(still.json()).toMatchObject({ title, deletedAt: null });
  });

  dbTest("retire PUT et POST /export, et exige la version de schéma pour la synchro", async () => {
    const user = await createAccount("user");
    const created = await createOwned(user.cookie, "novel", "Sync");
    const put = await call("PUT", `/api/v1/documents/${created.id}`, user.cookie, JSON.stringify({ fontFamily: "sans" }));
    expect(put.statusCode).toBe(404);
    const legacy = await call("POST", `/api/v1/documents/${created.id}/export`, user.cookie, "{}");
    expect(legacy.statusCode).toBe(404);
    // POST /exports existe désormais : un corps vide est refusé, pas ignoré.
    const exports = await call("POST", `/api/v1/documents/${created.id}/exports`, user.cookie, "{}");
    expect(exports.statusCode).toBe(422);
    const frame = Buffer.from(encodeSyncReply(new Uint8Array(), new Uint8Array()));
    const early = await call("POST", `/api/v1/documents/${created.id}/sync`, user.cookie, frame, {
      "content-type": "application/octet-stream",
    });
    expect(early.statusCode).toBe(426);
    const synced = await call("POST", `/api/v1/documents/${created.id}/sync`, user.cookie, frame, {
      "content-type": "application/octet-stream",
      "x-flaw-schema-version": "1",
    });
    expect(synced.statusCode).toBe(200);
    expect(synced.headers["content-type"]).toContain("application/octet-stream");
    // Réponse : l'état du serveur (texte créé) et son vecteur d'état.
    expect(decodeSyncRequest(new Uint8Array(synced.rawPayload))).toBeDefined();
    const read = await call("GET", `/api/v1/documents/${created.id}`, user.cookie);
    expect(read.statusCode).toBe(200);
    const patched = await call(
      "PATCH",
      `/api/v1/documents/${created.id}`,
      user.cookie,
      JSON.stringify({ fontFamily: "EB Garamond" }),
    );
    expect(patched.statusCode).toBe(200);
    const removed = await call("DELETE", `/api/v1/documents/${created.id}?permanent=false`, user.cookie);
    expect(removed.statusCode).toBe(204);
  });

  dbTest("ignore owner_id et id fournis par le client hors création", async () => {
    const userA = await createAccount("user");
    const userB = await createAccount("user");
    const created = await createOwned(userA.cookie, "novel", "Stable");
    const accepted = await call(
      "PATCH",
      `/api/v1/documents/${created.id}`,
      userA.cookie,
      JSON.stringify({ fontFamily: "Palatino", owner_id: userB.userId, id: userB.userId }),
    );
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ id: created.id, fontFamily: "Palatino" });
    const stored = await withActor(pool, userA.userId, (sql) =>
      sql.query<{ owner_id: string }>("SELECT owner_id FROM flaw.documents WHERE id = $1", [created.id]),
    );
    expect(stored.rows[0]?.owner_id).toBe(userA.userId);
    const denied = await call(
      "PATCH",
      `/api/v1/documents/${created.id}`,
      userB.cookie,
      JSON.stringify({ fontFamily: "Comic", owner_id: userB.userId }),
    );
    expect(denied.statusCode).toBe(404);
    expect(denied.json()).toEqual(problem(404));
  });
});
