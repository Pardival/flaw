/**
 * Repli POST /documents/:id/sync (API-016) : trame, 426, 413, journal chiffré.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateDek, wrapDek } from "@flaw/crypto";
import { Client, Pool } from "pg";
import * as Y from "yjs";
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
import {
  CONTENT_FRAGMENT,
  clientTooOld,
  decodeSyncRequest,
  encodeSyncReply,
  encodeSyncRequest,
  parseSchemaHeader,
  payloadTooLarge,
} from "../../../../packages/sync/src/index.ts";
import { SCHEMA_VERSION } from "@flaw/schema/src/index.ts";

const POSTGRES_IMAGE =
  "postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873";
const DB_PASSWORD = "0123456789abcdef0123456789abcdef";
const HEX = "0123456789abcdef0123456789abcdef";
const ORIGIN = "https://flaw.test";
const MISSING = "00000000-0000-4000-8000-000000000099";
const PASSWORD_HASH = "$argon2id$v=19$m=65536$c2FsdA$aGFzaA";
const MARKER = "T019-phrase-secrete-ne-doit-pas-fuir";
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const dbTestsLabel = basename(fileURLToPath(import.meta.url));
const container = `flaw-t019-sync-${process.pid}`;

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
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function frame(update: Uint8Array, stateVector: Uint8Array = new Uint8Array()): Buffer {
  return Buffer.from(encodeSyncRequest(stateVector, update));
}

/** Vraie mise à jour Yjs : un paragraphe dans le fragment du contenu. */
function realUpdate(text: string): { doc: Y.Doc; update: Uint8Array } {
  const doc = new Y.Doc();
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.insert(0, [new Y.XmlText(text)]);
  doc.getXmlFragment(CONTENT_FRAGMENT).insert(0, [paragraph]);
  return { doc, update: Y.encodeStateAsUpdate(doc) };
}

describe("trame et version de schéma", () => {
  it("encode une réponse vide et refuse une trame tronquée", () => {
    const empty = encodeSyncReply(new Uint8Array(), new Uint8Array());
    expect([...empty]).toEqual([0, 0]);
    expect(decodeSyncRequest(empty)).toEqual({ stateVector: new Uint8Array(), update: new Uint8Array() });
    expect(decodeSyncRequest(new Uint8Array())).toEqual({ stateVector: new Uint8Array(), update: new Uint8Array() });
    const update = new Uint8Array([9, 8, 7]);
    const state = new Uint8Array([1, 2]);
    expect(decodeSyncRequest(encodeSyncRequest(state, update))).toEqual({ stateVector: state, update });
    const reply = encodeSyncReply(update, state);
    expect(decodeSyncRequest(reply)).toEqual({ stateVector: update, update: state });
    expect(decodeSyncRequest(Uint8Array.from([0x80]))).toBeUndefined();
    expect(decodeSyncRequest(Uint8Array.from([1]))).toBeUndefined();
    expect(payloadTooLarge(11, 10)).toBe(true);
    expect(payloadTooLarge(10, 10)).toBe(false);
  });

  it("refuse un client plus ancien que le texte et accepte un client plus récent", () => {
    expect(parseSchemaHeader(undefined)).toBeUndefined();
    expect(parseSchemaHeader("01")).toBeUndefined();
    expect(parseSchemaHeader("1")).toBe(1);
    expect(parseSchemaHeader("2")).toBe(2);
    expect(clientTooOld(undefined, 1)).toBe(true);
    expect(clientTooOld(0, 1)).toBe(true);
    expect(clientTooOld(1, 1)).toBe(false);
    expect(clientTooOld(2, 1)).toBe(false);
    expect(clientTooOld(1, 2)).toBe(true);
  });
});

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

describe("garde HTTP sans base", () => {
  it("répond 401 sans session, 403 si l'origine ou le type est refusé, 413 si la charge dépasse la limite", async () => {
    const app = buildApp(config());
    const url = `/api/v1/documents/${MISSING}/sync`;
    const anonymous = await app.inject({
      method: "POST",
      url,
      headers: { origin: ORIGIN, "content-type": "application/octet-stream" },
      payload: Buffer.from([0, 0]),
    });
    expect(anonymous.statusCode).toBe(401);
    const evil = await app.inject({
      method: "POST",
      url,
      headers: {
        cookie: `${SESSION_COOKIE}=jeton`,
        origin: "https://evil.example",
        "content-type": "application/octet-stream",
      },
      payload: Buffer.from([0, 0]),
    });
    expect(evil.statusCode).toBe(403);
    expect(evil.json()).toEqual(problem(403, "origine refusée"));
    const plain = await app.inject({
      method: "POST",
      url,
      headers: {
        cookie: `${SESSION_COOKIE}=jeton`,
        origin: ORIGIN,
        "content-type": "text/plain",
      },
      payload: "bonjour",
    });
    expect(plain.statusCode).toBe(403);
    const huge = await app.inject({
      method: "POST",
      url,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(11 * 1024 * 1024),
        origin: ORIGIN,
      },
      payload: Buffer.from([0]),
    });
    expect(huge.statusCode).toBe(413);
    expect(huge.json()).toMatchObject({ status: 413, code: "payload_too_large" });
    await app.close();
  });
});

describe("journal sur PostgreSQL", () => {
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

  function docker(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync("docker", args, { encoding: "utf8" });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }

  async function call(
    method: "POST" | "GET",
    url: string,
    cookie: string,
    payload?: string | Buffer,
    headers: Record<string, string> = {},
  ) {
    return app.inject({
      method,
      url,
      remoteAddress: "172.31.250.10",
      headers: {
        cookie,
        ...(method === "POST" ? { origin: ORIGIN, "content-type": "application/octet-stream" } : {}),
        ...headers,
      },
      ...(method === "POST" ? { payload: payload ?? Buffer.from([0, 0]) } : {}),
    });
  }

  async function createAccount(): Promise<{ userId: string; cookie: string }> {
    userN += 1;
    const inserted = await pool.query<{ id: string }>("INSERT INTO flaw.users (role) VALUES ('user') RETURNING id", []);
    const userId = inserted.rows[0]?.id;
    if (userId === undefined) {
      throw new Error("utilisateur absent");
    }
    await pool.query(
      "INSERT INTO flaw.accounts (owner_id, provider_id, account_id, password_hash) VALUES ($1, 'credential', $2, $3)",
      [userId, `t019-${userN}@box.invalid`, PASSWORD_HASH],
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
    await pool.query(
      `INSERT INTO flaw.sessions (
         owner_id, token_hash, expires_at, created_at, last_activity_at,
         absolute_expires_at, browser, os, remember, restricted, reauthenticated_at
       ) VALUES ($1, $2, $3, $4, $4, $5, 'inconnu', 'inconnu', true, false, $4)`,
      [userId, issued.hash, new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000), now, new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000)],
    );
    return { userId, cookie: `${SESSION_COOKIE}=${issued.token}` };
  }

  async function createOwned(cookie: string): Promise<string> {
    const id = uuidV7();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/documents",
      remoteAddress: "172.31.250.10",
      headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
      payload: JSON.stringify({ id, mode: "novel", title: "Sync" }),
    });
    expect(response.statusCode).toBe(201);
    return id;
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
    secretDir = mkdtempSync(join(tmpdir(), "flaw-t019-secrets-"));
    writeFileSync(join(secretDir, "app_db_password"), DB_PASSWORD);
    writeFileSync(join(secretDir, "db_owner_password"), DB_PASSWORD);
    chmodSync(join(secretDir, "app_db_password"), 0o600);
    chmodSync(join(secretDir, "db_owner_password"), 0o600);
    expect(docker(["exec", container, "mkdir", "-p", "/run/secrets", "/tmp/initdb"]).status).toBe(0);
    for (const name of ["app_db_password", "db_owner_password"]) {
      expect(docker(["cp", join(secretDir, name), `${container}:/run/secrets/${name}`]).status).toBe(0);
    }
    expect(docker(["cp", join(root, "infra/initdb/01-role-applicatif.sh"), `${container}:/tmp/initdb/01-role-applicatif.sh`]).status).toBe(0);
    expect(docker(["cp", join(root, "infra/initdb/secret-valide.inc"), `${container}:/tmp/initdb/secret-valide.inc`]).status).toBe(0);
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
      max: 4,
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

  dbTest("journalise une mise à jour chiffrée, la déduplique, et refuse l'ancien schéma", async () => {
    const user = await createAccount();
    const id = await createOwned(user.cookie);
    const { doc: client, update } = realUpdate(MARKER);
    const missingHeader = await call("POST", `/api/v1/documents/${id}/sync`, user.cookie, frame(update));
    expect(missingHeader.statusCode).toBe(426);
    expect(missingHeader.json()).toEqual({
      type: "about:blank",
      status: 426,
      title: "Mise à jour requise",
      code: "upgrade_required",
    });
    const ancient = await call("POST", `/api/v1/documents/${id}/sync`, user.cookie, frame(update), {
      "x-flaw-schema-version": "0",
    });
    expect(ancient.statusCode).toBe(426);
    const broken = await call("POST", `/api/v1/documents/${id}/sync`, user.cookie, Buffer.from([0x80]), {
      "x-flaw-schema-version": String(SCHEMA_VERSION),
    });
    expect(broken.statusCode).toBe(422);
    const headers = { "x-flaw-schema-version": String(SCHEMA_VERSION) };
    const known = Y.encodeStateVector(client);
    const synced = await call("POST", `/api/v1/documents/${id}/sync`, user.cookie, frame(update, known), headers);
    expect(synced.statusCode).toBe(200);
    expect(synced.headers["content-type"]).toContain("application/octet-stream");
    // Le client connaît déjà tout : la réponse ne renvoie pas son texte.
    expect(decodeSyncRequest(new Uint8Array(synced.rawPayload))).toBeDefined();
    expect(synced.rawPayload.includes(Buffer.from(MARKER))).toBe(false);
    const replay = await call("POST", `/api/v1/documents/${id}/sync`, user.cookie, frame(update, known), headers);
    expect(replay.statusCode).toBe(200);
    client.getXmlFragment(CONTENT_FRAGMENT).insert(1, [new Y.XmlElement("paragraph")]);
    const next = Y.encodeStateAsUpdate(client, known);
    const newer = await call("POST", `/api/v1/documents/${id}/sync`, user.cookie, frame(next, Y.encodeStateVector(client)), {
      "x-flaw-schema-version": "2",
    });
    expect(newer.statusCode).toBe(200);
    const rows = await withActor(pool, user.userId, (sql) =>
      sql.query<{ update_ct: Buffer; projection_ct: Buffer; state_ct: Buffer }>(
        `SELECT u.update_ct, d.projection_ct, s.state_ct
         FROM flaw.document_updates u
         JOIN flaw.documents d ON d.id = u.document_id AND d.owner_id = u.owner_id
         JOIN flaw.document_states s ON s.document_id = d.id AND s.owner_id = d.owner_id
         WHERE u.document_id = $1 AND u.owner_id = $2
         ORDER BY u.created_at`,
        [id, user.userId],
      ),
    );
    expect(rows.rows).toHaveLength(2);
    for (const row of rows.rows) {
      expect(row.update_ct.includes(Buffer.from(MARKER))).toBe(false);
      expect(row.projection_ct.includes(Buffer.from(MARKER))).toBe(false);
      expect(row.state_ct.includes(Buffer.from(MARKER))).toBe(false);
    }
    const read = await call("GET", `/api/v1/documents/${id}`, user.cookie);
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ title: "Sync", schemaVersion: SCHEMA_VERSION });
  });

  dbTest("refuse le texte d'un autre compte comme un texte absent", async () => {
    const userA = await createAccount();
    const userB = await createAccount();
    const id = await createOwned(userA.cookie);
    const payload = frame(new Uint8Array([1, 2, 3]));
    const headers = { "x-flaw-schema-version": String(SCHEMA_VERSION) };
    const foreign = await call("POST", `/api/v1/documents/${id}/sync`, userB.cookie, payload, headers);
    const missing = await call("POST", `/api/v1/documents/${MISSING}/sync`, userB.cookie, payload, headers);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toEqual(problem(404));
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual(foreign.json());
    expect(foreign.body).not.toContain(id);
    const count = await withActor(pool, userA.userId, (sql) =>
      sql.query<{ n: number }>("SELECT count(*)::int AS n FROM flaw.document_updates WHERE document_id = $1", [id]),
    );
    expect(count.rows[0]?.n).toBe(0);
  });
});
