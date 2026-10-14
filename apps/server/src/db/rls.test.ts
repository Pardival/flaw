/**
 * T-005 — AC-095, AC-096, AC-102, SEC-DB-02, SEC-DB-03, SEC-DB-05, SEC-DATA-01.
 * Postgres 18.6 épinglé. Le rôle vient de infra/initdb/01-role-applicatif.sh.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Client } from "pg";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, appRoleEcarts, assertAppRole, infraSql } from "./migrate.ts";
import { APP_USER_PREDICATE, OWNER_TABLES, RLS_TABLES, TABLE_NAMES } from "./schema.ts";

const POSTGRES_IMAGE =
  "postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873";
const DB_PASSWORD = "0123456789abcdef0123456789abcdef";
const HMAC_A = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const HMAC_B = "0123456789abcde00123456789abcde00123456789abcde00123456789abcde0";
const HMAC_C = "0123456789abcde10123456789abcde10123456789abcde10123456789abcde1";
const INJECTION = "' OR 1=1 --";
const TRACKERS = ["google-analytics", "googletagmanager", "segment.io", "plausible.io"];
const PLAIN_TABLES = [
  "users",
  "accounts",
  "sessions",
  "verifications",
  "rate_limits",
  "erasure_log",
  "erasure_outbox",
  "erasure_journal_head",
  "audit_events",
  "auth_events",
  "auth_factors",
  "recovery_codes",
  "user_keys",
  "user_preferences",
  "daily_progress",
] as const;

const GRANTS: Record<string, { sel: boolean; ins: boolean; upd: boolean; del: boolean }> = {
  users: { sel: true, ins: true, upd: true, del: true },
  accounts: { sel: true, ins: true, upd: true, del: true },
  sessions: { sel: true, ins: true, upd: true, del: true },
  verifications: { sel: true, ins: true, upd: true, del: true },
  auth_factors: { sel: true, ins: true, upd: true, del: true },
  recovery_codes: { sel: true, ins: true, upd: true, del: true },
  user_keys: { sel: true, ins: true, upd: true, del: true },
  user_preferences: { sel: true, ins: true, upd: true, del: true },
  daily_progress: { sel: true, ins: true, upd: true, del: true },
  rate_limits: { sel: true, ins: true, upd: true, del: true },
  documents: { sel: true, ins: true, upd: true, del: true },
  document_states: { sel: true, ins: true, upd: true, del: true },
  document_updates: { sel: true, ins: true, upd: true, del: true },
  document_versions: { sel: true, ins: true, upd: true, del: true },
  audit_events: { sel: true, ins: true, upd: false, del: false },
  erasure_log: { sel: true, ins: false, upd: false, del: false },
  erasure_outbox: { sel: true, ins: true, upd: false, del: false },
  erasure_journal_head: { sel: true, ins: true, upd: false, del: false },
  auth_events: { sel: false, ins: true, upd: false, del: false },
};

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const container = `flaw-t005-rls-${process.pid}`;

const SORTS = {
  created_at: sql.identifier("created_at"),
  updated_at: sql.identifier("updated_at"),
  counter: sql.identifier("counter"),
} as const;

type Database = NodePgDatabase;

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) {
    return result as Array<Record<string, unknown>>;
  }
  if (result !== null && typeof result === "object" && "rows" in result && Array.isArray(result.rows)) {
    return result.rows as Array<Record<string, unknown>>;
  }
  throw new Error("résultat SQL illisible");
}

function docker(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function errorText(error: unknown): string {
  const parts: string[] = [];
  let current = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    parts.push(current.message);
    if ("code" in current && typeof current.code === "string") {
      parts.push(current.code);
    }
    current = current.cause;
  }
  return parts.join("\n");
}

async function withUser<T>(db: Database, userId: string, run: (tx: Database) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    return run(tx as unknown as Database);
  });
}

describe("migration SQL et compose", () => {
  const migration = readFileSync(join(root, "apps/server/drizzle/0000_init.sql"), "utf8");
  const compose = readFileSync(join(root, "infra/docker-compose.yml"), "utf8");
  const dockerfile = readFileSync(join(root, "apps/server/Dockerfile"), "utf8");
  const droits = readFileSync(join(root, "infra/droits-flaw.sql"), "utf8");

  it("crée les 19 tables, l'enveloppe et la RLS des 4 tables de contenu", () => {
    expect(TABLE_NAMES).toHaveLength(19);
    expect(migration).toContain("CREATE TABLE flaw.erasure_outbox (");
    expect(migration).toContain("CREATE TABLE flaw.erasure_journal_head (");
    expect(migration).toContain("INSERT INTO flaw.erasure_outbox");
    expect(migration).not.toContain("CREATE FUNCTION flaw.journal_prochaine");
    for (const name of TABLE_NAMES) {
      expect(migration).toContain(`CREATE TABLE flaw.${name} (`);
    }
    for (const name of RLS_TABLES) {
      expect(migration).toContain(`ALTER TABLE flaw.${name} ENABLE ROW LEVEL SECURITY;`);
      expect(migration).toContain(`ALTER TABLE flaw.${name} FORCE ROW LEVEL SECURITY;`);
    }
    for (const name of PLAIN_TABLES) {
      expect(migration).not.toContain(`ALTER TABLE flaw.${name} ENABLE ROW LEVEL SECURITY`);
    }
    expect(migration).toContain(APP_USER_PREDICATE);
    expect(migration).toContain("CONSTRAINT documents_id_owner_uidx UNIQUE (id, owner_id)");
    expect(migration).toContain("document_states_document_owner_fk");
    expect(migration).toContain("document_updates_document_owner_fk");
    expect(migration).toContain("document_versions_document_owner_fk");
    expect(migration).toContain("FOREIGN KEY (document_id, owner_id) REFERENCES flaw.documents (id, owner_id)");
    expect(migration).toContain("projection_ct");
    expect(migration).toContain("interval '440 days'");
    expect(migration).toContain("CREATE FUNCTION flaw.purge_journaux()");
    expect(migration).not.toContain("CREATE FUNCTION flaw.purge_expired()");
    expect(migration).not.toContain(" title ");
    expect(migration).not.toContain("CREATE POLICY auth_events");
    expect(droits).toContain("GRANT INSERT ON TABLE flaw.auth_events TO flaw_app;");
    expect(droits).toContain("GRANT SELECT ON TABLE flaw.erasure_log TO flaw_app;");
    expect(droits).toContain("GRANT SELECT, INSERT ON TABLE flaw.erasure_outbox, flaw.erasure_journal_head TO flaw_app;");
    expect(migration).toContain("pepper_id text NOT NULL");
    expect(migration).toContain("code_hmac bytea NOT NULL");
    expect(migration).toContain("CONSTRAINT recovery_codes_user_code_hmac_uidx UNIQUE (user_id, code_hmac)");
    expect(migration).not.toContain("code_hash");
    expect(droits).toContain("GRANT SELECT, INSERT ON TABLE flaw.audit_events TO flaw_app;");
  });

  it("ne référence aucun traceur (AC-102)", () => {
    const sources = [
      migration,
      readFileSync(join(root, "apps/server/src/db/schema.ts"), "utf8"),
      readFileSync(join(root, "apps/server/src/db/migrate.ts"), "utf8"),
      compose,
    ];
    for (const source of sources) {
      for (const host of TRACKERS) {
        expect(source).not.toContain(host);
      }
    }
  });

  it("branche migrate sur flaw_owner et l'app sur flaw_app (AC-095)", () => {
    const migrateBlock = compose.split("\n  migrate:\n")[1]?.split("\n  app:\n")[0] ?? "";
    const appBlock = compose.split("\n  app:\n")[1]?.split("\n  db:\n")[0] ?? "";
    const dbBlock = compose.split("\n  db:\n")[1]?.split("\nsecrets:\n")[0] ?? "";
    const initdb = readFileSync(join(root, "infra/initdb/01-role-applicatif.sh"), "utf8");
    const secrets = readFileSync(join(root, "infra/creer-secrets.sh"), "utf8");
    expect(compose).toContain(POSTGRES_IMAGE);
    expect(migrateBlock).toContain('command: ["node", "apps/server/src/db/migrate.ts"]');
    expect(migrateBlock).toContain("DATABASE_USER: flaw_owner");
    expect(migrateBlock).toContain("secrets: [db_owner_password]");
    expect(migrateBlock).toContain('user: "10001:10001"');
    expect(migrateBlock).not.toContain("app_db_password");
    expect(migrateBlock).not.toContain("hmac_pepper");
    expect(compose).toContain("DATABASE_USER: flaw_app");
    expect(appBlock).toContain("hmac_pepper");
    expect(appBlock).not.toContain("db_owner_password");
    expect(dbBlock).toContain("db_owner_password");
    expect(initdb).toContain("CREATE SCHEMA IF NOT EXISTS flaw AUTHORIZATION flaw_owner");
    expect(initdb).toContain("REVOKE CREATE ON DATABASE");
    expect(initdb).toContain("NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS");
    expect(initdb).toContain("CREATE ROLE flaw_journal NOLOGIN");
    expect(initdb).not.toContain("AUTHORIZATION flaw_app");
    expect(secrets).toContain("db_owner_password 10001:70 440 hex32");
    expect(secrets).toContain("hmac_pepper 10001:10001 400 kek");
    expect(dockerfile).toContain("COPY --from=build /src/apps/server/drizzle /app/apps/server/drizzle");
    expect(dockerfile).toContain("chmod 444 /app/infra/droits-flaw.sql /app/infra/assert-app-role.sql");
  });
});

describe("rôle flaw_app, RLS et requêtes paramétrées", () => {
  let admin: Client;
  let owner: Client;
  let app: Client;
  let db: Database;
  let port = 0;
  let secretDir = "";

  beforeAll(async () => {
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

    secretDir = mkdtempSync(join(tmpdir(), "flaw-t005-secrets-"));
    writeFileSync(join(secretDir, "app_db_password"), DB_PASSWORD);
    writeFileSync(join(secretDir, "db_owner_password"), DB_PASSWORD);
    const prepared = docker(["exec", container, "mkdir", "-p", "/run/secrets", "/tmp/initdb"]);
    expect(prepared.status, prepared.stderr).toBe(0);
    for (const name of ["app_db_password", "db_owner_password"]) {
      const copied = docker(["cp", join(secretDir, name), `${container}:/run/secrets/${name}`]);
      expect(copied.status, copied.stderr).toBe(0);
    }
    const scripts = docker([
      "cp",
      join(root, "infra/initdb/01-role-applicatif.sh"),
      `${container}:/tmp/initdb/01-role-applicatif.sh`,
    ]);
    expect(scripts.status, scripts.stderr).toBe(0);
    const validator = docker([
      "cp",
      join(root, "infra/initdb/secret-valide.inc"),
      `${container}:/tmp/initdb/secret-valide.inc`,
    ]);
    expect(validator.status, validator.stderr).toBe(0);
    const owned = docker([
      "exec",
      "-u",
      "root",
      container,
      "chown",
      "70:70",
      "/run/secrets/app_db_password",
      "/run/secrets/db_owner_password",
    ]);
    expect(owned.status, owned.stderr).toBe(0);
    const mode = docker([
      "exec",
      "-u",
      "root",
      container,
      "chmod",
      "440",
      "/run/secrets/app_db_password",
      "/run/secrets/db_owner_password",
    ]);
    expect(mode.status, mode.stderr).toBe(0);
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

    admin = await connectStable("postgres");
    owner = await connectStable("flaw_owner");
    await applyMigrations(owner);
    app = await connectStable("flaw_app");
    await assertAppRole(app);
    db = drizzle(app);
  }, 180_000);

  afterAll(async () => {
    await app?.end().catch(() => undefined);
    await owner?.end().catch(() => undefined);
    await admin?.end().catch(() => undefined);
    if (secretDir !== "") {
      rmSync(secretDir, { recursive: true, force: true });
    }
    docker(["rm", "-f", container]);
  });

  it("refuse le superutilisateur et isole deux comptes (SEC-DB-02, SEC-DB-05, SEC-DATA-01, AC-096)", async () => {
    await assertAppRole(app);

    const roles = rowsOf(
      await db.execute(sql`
        select rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolinherit, rolcanlogin
        from pg_roles
        where rolname in ('flaw_owner', 'flaw_app', 'flaw_journal')
      `),
    );
    expect(roles).toHaveLength(3);
    for (const role of roles) {
      expect(role.rolsuper, String(role.rolname)).toBe(false);
      expect(role.rolcreatedb, String(role.rolname)).toBe(false);
      expect(role.rolcreaterole, String(role.rolname)).toBe(false);
      expect(role.rolreplication, String(role.rolname)).toBe(false);
      expect(role.rolbypassrls, String(role.rolname)).toBe(false);
      expect(role.rolinherit, String(role.rolname)).toBe(false);
    }
    expect(roles.find((role) => role.rolname === "flaw_journal")?.rolcanlogin).toBe(false);

    const catalog = rowsOf(
      await db.execute(sql`
        select c.relname as name, pg_get_userbyid(c.relowner) as owner
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'flaw' and c.relkind = 'r'
        order by c.relname
      `),
    );
    expect(catalog.map((row) => String(row.name)).sort()).toEqual([...TABLE_NAMES].sort());
    for (const row of catalog) {
      expect(row.owner, String(row.name)).toBe("flaw_owner");
    }
    const functions = rowsOf(
      await db.execute(sql`
        select p.proname as name, pg_get_userbyid(p.proowner) as owner
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'flaw'
      `),
    );
    expect(functions.map((row) => String(row.name)).sort()).toEqual(["journaliser_effacement", "purge_journaux"]);
    for (const row of functions) {
      expect(row.owner).toBe("flaw_owner");
    }

    const owners = rowsOf(
      await db.execute(sql`
        select c.relname as name, a.attnotnull as not_null,
          exists (
            select 1 from pg_index i
            where i.indrelid = c.oid and a.attnum = any (i.indkey)
          ) as indexed
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute a on a.attrelid = c.oid and a.attname = 'owner_id' and not a.attisdropped
        where n.nspname = 'flaw'
      `),
    );
    const ownerByName = new Map(owners.map((row) => [String(row.name), row]));
    for (const name of OWNER_TABLES) {
      const row = ownerByName.get(name);
      expect(row, name).toBeDefined();
      expect(row?.not_null, name).toBe(true);
      expect(row?.indexed, name).toBe(true);
    }

    const flags = rowsOf(
      await db.execute(sql`
        select c.relname as name, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'flaw' and c.relkind = 'r'
      `),
    );
    const flagByName = new Map(flags.map((row) => [String(row.name), row]));
    for (const name of RLS_TABLES) {
      expect(flagByName.get(name)?.enabled, name).toBe(true);
      expect(flagByName.get(name)?.forced, name).toBe(true);
    }
    for (const name of ["users", "accounts", "sessions", "verifications", "rate_limits", "auth_events"]) {
      expect(flagByName.get(name)?.enabled, name).toBe(false);
      expect(flagByName.get(name)?.forced, name).toBe(false);
    }

    const policies = rowsOf(
      await db.execute(sql`
        select c.relname as name, pg_get_expr(p.polqual, p.polrelid) as using_expr
        from pg_policy p
        join pg_class c on c.oid = p.polrelid
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'flaw'
      `),
    );
    expect(policies.map((policy) => String(policy.name)).sort()).toEqual([...RLS_TABLES].sort());
    for (const policy of policies) {
      const expression = String(policy.using_expr);
      expect(expression).toContain("NULLIF");
      expect(expression).toContain("current_setting('app.user_id'");
      expect(expression).toContain("::uuid");
    }

    const seen = new Set(catalog.map((row) => String(row.name)));
    for (const name of seen) {
      expect(GRANTS[name], name).toBeDefined();
    }
    for (const [name, grant] of Object.entries(GRANTS)) {
      for (const [privilege, allowed] of [
        ["SELECT", grant.sel],
        ["INSERT", grant.ins],
        ["UPDATE", grant.upd],
        ["DELETE", grant.del],
        ["TRUNCATE", false],
      ] as const) {
        const allowedRows = rowsOf(
          await db.execute(
            sql`select has_table_privilege('flaw_app', ${`flaw.${name}`}, ${privilege}) as allowed`,
          ),
        );
        expect(allowedRows[0]?.allowed, `${name} ${privilege}`).toBe(allowed);
      }
    }

    const userA = crypto.randomUUID();
    const userB = crypto.randomUUID();
    const documentA = crypto.randomUUID();
    const documentB = crypto.randomUUID();
    const generated = rowsOf(
      await db.execute(sql`insert into flaw.users (role) values ('user') returning id`),
    );
    expect(String(generated[0]?.id).charAt(14)).toBe("7");

    await withUser(db, userA, async (tx) => {
      await tx.execute(sql`insert into flaw.users (id, role) values (${userA}, 'user')`);
      await tx.execute(sql`
        insert into flaw.documents (
          id, owner_id, mode, format, font, projection_ct, projection_nonce, key_id, enc_version
        ) values (
          ${documentA}, ${userA}, 'prose', 'plain', 'serif', '\\x01'::bytea, '\\x02'::bytea, 'kek-2026-10', 1
        )
      `);
      await tx.execute(sql`
        insert into flaw.document_states (
          document_id, owner_id, state_ct, state_nonce, key_id, enc_version
        ) values (
          ${documentA}, ${userA}, '\\x01'::bytea, '\\x02'::bytea, 'kek-2026-10', 1
        )
      `);
      await tx.execute(sql`insert into flaw.user_preferences (owner_id) values (${userA})`);
      await tx.execute(sql`
        insert into flaw.audit_events (owner_id, event_type, result) values (${userA}, 'read', 'ok')
      `);
    });

    await withUser(db, userB, async (tx) => {
      await tx.execute(sql`insert into flaw.users (id, role) values (${userB}, 'user')`);
      await tx.execute(sql`
        insert into flaw.documents (
          id, owner_id, mode, format, font, projection_ct, projection_nonce, key_id, enc_version
        ) values (
          ${documentB}, ${userB}, 'verse', 'fountain', 'mono', '\\x01'::bytea, '\\x02'::bytea, 'kek-2026-10', 1
        )
      `);
    });

    const seenByB = rowsOf(
      await withUser(db, userB, async (tx) => tx.execute(sql`select id, mode from flaw.documents`)),
    );
    expect(seenByB).toHaveLength(1);
    expect(seenByB[0]?.mode).toBe("verse");

    const withoutUser = rowsOf(await db.execute(sql`select id from flaw.documents`));
    expect(withoutUser).toHaveLength(0);

    const emptySetting = rowsOf(
      await db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.user_id', '', true)`);
        return tx.execute(sql`select id from flaw.documents`);
      }),
    );
    expect(emptySetting).toHaveLength(0);

    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userA}, true)`);
    });
    const afterCommit = rowsOf(await db.execute(sql`select id from flaw.documents`));
    expect(afterCommit).toHaveLength(0);

    const statesOfASeenByB = rowsOf(
      await withUser(db, userB, async (tx) => tx.execute(sql`select document_id from flaw.document_states`)),
    );
    expect(statesOfASeenByB).toHaveLength(0);

    await expect(
      withUser(db, userB, async (tx) =>
        tx.execute(sql`
          insert into flaw.documents (
            id, owner_id, mode, format, font, projection_ct, projection_nonce, key_id, enc_version
          ) values (
            ${crypto.randomUUID()}, ${userA}, 'prose', 'plain', 'serif', '\\x01'::bytea, '\\x02'::bytea, 'kek-2026-10', 1
          )
        `),
      ),
    ).rejects.toThrow();

    for (const run of [
      () => withUser(db, userA, async (tx) => tx.execute(sql`
        insert into flaw.document_states (document_id, owner_id, state_ct, state_nonce, key_id, enc_version)
        values (${documentB}, ${userA}, '\\x01'::bytea, '\\x02'::bytea, 'kek-2026-10', 1)
      `)),
      () => withUser(db, userA, async (tx) => tx.execute(sql`
        insert into flaw.document_updates (document_id, owner_id, update_ct, update_nonce, key_id, enc_version)
        values (${documentB}, ${userA}, '\\x01'::bytea, '\\x02'::bytea, 'kek-2026-10', 1)
      `)),
      () => withUser(db, userA, async (tx) => tx.execute(sql`
        insert into flaw.document_versions (document_id, owner_id, version_ct, version_nonce, key_id, enc_version)
        values (${documentB}, ${userA}, '\\x01'::bytea, '\\x02'::bytea, 'kek-2026-10', 1)
      `)),
    ]) {
      let thrown: unknown;
      try {
        await run();
      } catch (error) {
        thrown = error;
      }
      expect(errorText(thrown)).toMatch(/foreign key|23503/i);
    }
  }, 60_000);

  it("ignore une injection dans le filtre, l'identifiant et le tri (SEC-DB-03)", async () => {
    const userA = crypto.randomUUID();
    await withUser(db, userA, async (tx) => {
      await tx.execute(sql`insert into flaw.users (id, role) values (${userA}, 'user')`);
      await tx.execute(sql`
        insert into flaw.documents (
          id, owner_id, mode, format, font, projection_ct, projection_nonce, key_id, enc_version
        ) values (
          ${crypto.randomUUID()}, ${userA}, 'prose', 'plain', 'serif', '\\x01'::bytea, '\\x02'::bytea, 'kek-2026-10', 1
        )
      `);
    });

    const byMode = rowsOf(
      await withUser(db, userA, async (tx) =>
        tx.execute(sql`select id from flaw.documents where mode = ${INJECTION}`),
      ),
    );
    expect(byMode).toHaveLength(0);

    const byId = rowsOf(
      await withUser(db, userA, async (tx) =>
        tx.execute(sql`select id from flaw.documents where id::text = ${INJECTION}`),
      ),
    );
    expect(byId).toHaveLength(0);

    const sort = SORTS[INJECTION as keyof typeof SORTS] ?? SORTS.created_at;
    const ordered = rowsOf(
      await withUser(db, userA, async (tx) =>
        tx.execute(sql`select id, mode from flaw.documents order by ${sort}`),
      ),
    );
    expect(ordered.length).toBeGreaterThan(0);
    expect(ordered.every((row) => row.mode === "prose" || row.mode === "verse")).toBe(true);
  });

  it("réapplique la migration sans changer le schéma", async () => {
    await applyMigrations(owner);
    const again = rowsOf(
      await db.execute(sql`
        select count(*)::int as n
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'flaw' and c.relkind = 'r'
      `),
    );
    expect(Number(again[0]?.n)).toBe(TABLE_NAMES.length);
    expect(await appRoleEcarts(app)).toEqual([]);
  });

  it("refuse DROP, ALTER, TRUNCATE, CREATE et les écritures de journaux", async () => {
    await expect(app.query("DROP TABLE flaw.documents")).rejects.toThrow();
    await expect(app.query("ALTER TABLE flaw.documents DISABLE ROW LEVEL SECURITY")).rejects.toThrow();
    await expect(app.query("ALTER TABLE flaw.documents NO FORCE ROW LEVEL SECURITY")).rejects.toThrow();
    await expect(app.query("CREATE SCHEMA hors_pack")).rejects.toThrow();
    await expect(app.query("CREATE TABLE flaw.intrus (id integer)")).rejects.toThrow();
    await expect(app.query("TRUNCATE flaw.users")).rejects.toThrow();
    await expect(app.query("TRUNCATE flaw.accounts")).rejects.toThrow();
    await expect(app.query("TRUNCATE flaw.sessions")).rejects.toThrow();
    await expect(app.query("TRUNCATE flaw.verifications")).rejects.toThrow();
    await expect(app.query("TRUNCATE flaw.auth_factors")).rejects.toThrow();
    await expect(app.query("TRUNCATE flaw.recovery_codes")).rejects.toThrow();
    await expect(app.query("TRUNCATE flaw.user_keys")).rejects.toThrow();
    await expect(app.query("TRUNCATE flaw.user_preferences")).rejects.toThrow();
    await expect(app.query("TRUNCATE flaw.daily_progress")).rejects.toThrow();
    await expect(app.query("TRUNCATE flaw.rate_limits")).rejects.toThrow();
    await expect(app.query("TRUNCATE flaw.erasure_log")).rejects.toThrow();
    await expect(app.query("TRUNCATE flaw.erasure_outbox")).rejects.toThrow();
    await expect(app.query("TRUNCATE flaw.erasure_journal_head")).rejects.toThrow();
    await expect(app.query("UPDATE flaw.erasure_outbox SET seq = 1")).rejects.toThrow();
    await expect(app.query("DELETE FROM flaw.erasure_outbox")).rejects.toThrow();
    await expect(app.query("UPDATE flaw.erasure_journal_head SET seq = 1")).rejects.toThrow();
    await expect(app.query("DELETE FROM flaw.erasure_journal_head")).rejects.toThrow();
    await expect(app.query("TRUNCATE flaw.audit_events")).rejects.toThrow();
    await expect(app.query("TRUNCATE flaw.auth_events")).rejects.toThrow();
    await expect(app.query("TRUNCATE flaw.documents")).rejects.toThrow();
    await expect(app.query("TRUNCATE flaw.document_states")).rejects.toThrow();
    await expect(app.query("TRUNCATE flaw.document_updates")).rejects.toThrow();
    await expect(app.query("TRUNCATE flaw.document_versions")).rejects.toThrow();
    await expect(app.query("SELECT id FROM flaw.auth_events")).rejects.toThrow();
    await expect(app.query("UPDATE flaw.audit_events SET result = 'x'")).rejects.toThrow();
    await expect(app.query("DELETE FROM flaw.audit_events")).rejects.toThrow();
    await expect(app.query("INSERT INTO flaw.erasure_log (subject, subject_id, owner_id) VALUES ('user', gen_random_uuid(), gen_random_uuid())")).rejects.toThrow();
    await expect(app.query("DELETE FROM flaw.erasure_log")).rejects.toThrow();

    await app.query(
      "INSERT INTO flaw.auth_events (event_type, subject_hmac, ip_hmac, user_agent_summary) VALUES ($1, $2, $3, $4)",
      ["login_failed", HMAC_A, HMAC_B, "Mozilla"],
    );
    await expect(app.query("SELECT subject_hmac FROM flaw.auth_events")).rejects.toThrow();
    const audit = await app.query("SELECT event_type FROM flaw.audit_events");
    expect(audit.rows.length).toBeGreaterThan(0);
  });

  it("tient les checks d'erasure_log et le déclencheur d'effacement", async () => {
    const subject = crypto.randomUUID();
    const other = crypto.randomUUID();
    await expect(
      owner.query(
        "INSERT INTO flaw.erasure_log (subject, subject_id, owner_id) VALUES ('user', $1, $2)",
        [subject, other],
      ),
    ).rejects.toThrow();
    await owner.query(
      "INSERT INTO flaw.erasure_log (subject, subject_id, owner_id) VALUES ('document', $1, $2)",
      [subject, other],
    );

    const userA = crypto.randomUUID();
    const documentA = crypto.randomUUID();
    await withUser(db, userA, async (tx) => {
      await tx.execute(sql`insert into flaw.users (id, role) values (${userA}, 'user')`);
      await tx.execute(sql`
        insert into flaw.documents (
          id, owner_id, mode, format, font, projection_ct, projection_nonce, key_id, enc_version
        ) values (
          ${documentA}, ${userA}, 'prose', 'plain', 'serif', '\\x01'::bytea, '\\x02'::bytea, 'kek-2026-10', 1
        )
      `);
      await tx.execute(sql`delete from flaw.documents where id = ${documentA}`);
    });
    const journal = await app.query<{ subject: string; owner_id: string }>(
      "SELECT subject, owner_id FROM flaw.erasure_log WHERE subject_id = $1",
      [documentA],
    );
    expect(journal.rows).toEqual([{ subject: "document", owner_id: userA }]);
    const outbox = await app.query<{ subject: string; owner_id: string; seq: string | null; published_at: Date | null }>(
      "SELECT subject, owner_id, seq, published_at FROM flaw.erasure_outbox WHERE subject_id = $1",
      [documentA],
    );
    expect(outbox.rows).toEqual([{ subject: "document", owner_id: userA, seq: null, published_at: null }]);

    const replayUser = crypto.randomUUID();
    await app.query("INSERT INTO flaw.users (id, role) VALUES ($1, 'user')", [replayUser]);
    await owner.query("BEGIN");
    await owner.query("SELECT set_config('flaw.rejeu', 'on', true)");
    await owner.query("DELETE FROM flaw.users WHERE id = $1", [replayUser]);
    await owner.query("COMMIT");
    const replayLog = await app.query<{ origine: string }>(
      "SELECT origine FROM flaw.erasure_log WHERE subject_id = $1",
      [replayUser],
    );
    expect(replayLog.rows).toEqual([{ origine: "rejeu" }]);
    const replayOutbox = await app.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM flaw.erasure_outbox WHERE subject_id = $1",
      [replayUser],
    );
    expect(replayOutbox.rows[0]?.n).toBe(0);
  });

  it("aligne recovery_codes sur l'esquisse G13", async () => {
    const columns = await owner.query<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'flaw' AND table_name = 'recovery_codes'
       ORDER BY ordinal_position`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "id",
      "user_id",
      "pepper_id",
      "code_hmac",
      "used_at",
      "created_at",
    ]);
    expect(columns.rows.find((row) => row.column_name === "pepper_id")?.is_nullable).toBe("NO");
    expect(columns.rows.find((row) => row.column_name === "code_hmac")?.data_type).toBe("bytea");
    expect(columns.rows.find((row) => row.column_name === "used_at")?.is_nullable).toBe("YES");
    const names = columns.rows.map((row) => row.column_name).join(" ");
    expect(names).not.toMatch(/code_hash|secret_ct|ciphertext|owner_id/);

    const fk = await owner.query<{ confdeltype: string }>(
      `SELECT c.confdeltype
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = 'flaw' AND t.relname = 'recovery_codes' AND c.contype = 'f'`,
    );
    expect(fk.rows).toEqual([{ confdeltype: "c" }]);

    const userId = crypto.randomUUID();
    await app.query("INSERT INTO flaw.users (id, role) VALUES ($1, 'user')", [userId]);
    await app.query(
      "INSERT INTO flaw.recovery_codes (user_id, pepper_id, code_hmac) VALUES ($1, 'pep-2026-10', '\\x0101'::bytea)",
      [userId],
    );
    await expect(
      app.query(
        "INSERT INTO flaw.recovery_codes (user_id, pepper_id, code_hmac) VALUES ($1, 'pep-2026-10', '\\x0101'::bytea)",
        [userId],
      ),
    ).rejects.toThrow();
    await app.query("DELETE FROM flaw.users WHERE id = $1", [userId]);
    const left = await app.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM flaw.recovery_codes WHERE user_id = $1",
      [userId],
    );
    expect(left.rows[0]?.n).toBe(0);
  });

  it("purge les journaux au-delà des durées codées", async () => {
    const purge = await owner.query<{
      prosecdef: boolean;
      pronargs: number;
      proconfig: string[] | null;
      proacl: string | null;
    }>(
      `SELECT p.prosecdef, p.pronargs, p.proconfig, p.proacl::text AS proacl
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'flaw' AND p.proname = 'purge_journaux'`,
    );
    expect(purge.rows[0]?.prosecdef).toBe(true);
    expect(purge.rows[0]?.pronargs).toBe(0);
    expect(purge.rows[0]?.proconfig).toEqual(["search_path=pg_catalog, flaw, pg_temp"]);
    const proacl = purge.rows[0]?.proacl ?? "";
    expect(proacl).toContain("flaw_app=X/");
    expect(proacl).toContain("flaw_owner=X/");
    expect(proacl).not.toMatch(/[{,]=X\//);

    await owner.query(
      "INSERT INTO flaw.auth_events (event_type, created_at) VALUES ('login_failed', now() - interval '7 months')",
    );
    await owner.query("INSERT INTO flaw.auth_events (event_type, created_at) VALUES ('mfa_failed', now())");
    await app.query(
      "INSERT INTO flaw.audit_events (owner_id, event_type, result, created_at) VALUES ($1, 'old', 'ok', now() - interval '13 months')",
      [crypto.randomUUID()],
    );
    const recentAudit = crypto.randomUUID();
    await app.query(
      "INSERT INTO flaw.audit_events (owner_id, event_type, result, created_at) VALUES ($1, 'recent', 'ok', now())",
      [recentAudit],
    );
    await owner.query(
      "INSERT INTO flaw.erasure_log (subject, subject_id, owner_id, erased_at) VALUES ('document', $1, $1, now() - interval '441 days')",
      [crypto.randomUUID()],
    );
    const publishedOld = crypto.randomUUID();
    await app.query(
      "INSERT INTO flaw.erasure_outbox (subject, subject_id, owner_id, published_at) VALUES ('document', $1, $1, now() - interval '441 days')",
      [publishedOld],
    );
    const publishedRecent = crypto.randomUUID();
    await app.query(
      "INSERT INTO flaw.erasure_outbox (subject, subject_id, owner_id, published_at) VALUES ('document', $1, $1, now())",
      [publishedRecent],
    );
    const pending = crypto.randomUUID();
    await app.query(
      "INSERT INTO flaw.erasure_outbox (subject, subject_id, owner_id) VALUES ('document', $1, $1)",
      [pending],
    );
    const keptErasure = crypto.randomUUID();
    await owner.query(
      "INSERT INTO flaw.erasure_log (subject, subject_id, owner_id, erased_at) VALUES ('document', $1, $2, now())",
      [keptErasure, crypto.randomUUID()],
    );
    await app.query(
      "INSERT INTO flaw.verifications (identifier, value_hash, expires_at) VALUES ($1, $2, now() - interval '1 minute')",
      [HMAC_B, HMAC_C],
    );
    await app.query(
      "INSERT INTO flaw.verifications (identifier, value_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')",
      [HMAC_A, HMAC_C],
    );
    await expect(
      app.query(
        "INSERT INTO flaw.verifications (identifier, value_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')",
        ["reset-password:0123456789abcdef0123456789abcdef", HMAC_C],
      ),
    ).rejects.toThrow();
    await app.query(
      "INSERT INTO flaw.rate_limits (bucket, window_start, hits) VALUES ($1, now() - interval '2 hours', 1)",
      [HMAC_C],
    );
    await app.query(
      "INSERT INTO flaw.rate_limits (bucket, window_start, hits) VALUES ($1, now() - interval '1 hour', 1)",
      [HMAC_C],
    );

    await app.query("SELECT flaw.purge_journaux()");

    const authOld = await owner.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM flaw.auth_events WHERE created_at < now() - interval '6 months'",
    );
    expect(authOld.rows[0]?.n).toBe(0);
    const authKept = await owner.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM flaw.auth_events WHERE event_type = 'mfa_failed'",
    );
    expect(authKept.rows[0]?.n).toBe(1);
    const auditLeft = await app.query<{ event_type: string }>(
      "SELECT event_type FROM flaw.audit_events WHERE event_type IN ('old', 'recent')",
    );
    expect(auditLeft.rows.map((row) => row.event_type)).toEqual(["recent"]);
    const erasureOld = await app.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM flaw.erasure_log WHERE erased_at < now() - interval '400 days'",
    );
    expect(erasureOld.rows[0]?.n).toBe(0);
    const erasureKept = await app.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM flaw.erasure_log WHERE subject_id = $1",
      [keptErasure],
    );
    expect(erasureKept.rows[0]?.n).toBe(1);
    const outboxLeft = await app.query<{ subject_id: string }>(
      "SELECT subject_id FROM flaw.erasure_outbox WHERE subject_id IN ($1, $2, $3)",
      [publishedOld, publishedRecent, pending],
    );
    expect(outboxLeft.rows.map((row) => row.subject_id).sort()).toEqual([pending, publishedRecent].sort());
    const head = await app.query<{ n: number; seq: string }>(
      "SELECT count(*)::int AS n, min(seq)::text AS seq FROM flaw.erasure_journal_head",
    );
    expect(head.rows[0]?.n).toBe(1);
    expect(head.rows[0]?.seq).toBe("0");
    const verif = await app.query<{ identifier: string }>("SELECT identifier FROM flaw.verifications");
    expect(verif.rows.map((row) => row.identifier)).toContain(HMAC_A);
    expect(verif.rows.map((row) => row.identifier)).not.toContain(HMAC_B);
    const windows = await app.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM flaw.rate_limits WHERE bucket = $1",
      [HMAC_C],
    );
    expect(windows.rows[0]?.n).toBe(1);
  });

  it("signale un GRANT, une politique et une appartenance (G2, G4)", async () => {
    expect(await appRoleEcarts(app)).toEqual([]);

    await admin.query("GRANT SELECT ON TABLE flaw.auth_events TO flaw_app");
    expect(await appRoleEcarts(app)).toContain("privilege auth_events SELECT");
    await admin.query("REVOKE SELECT ON TABLE flaw.auth_events FROM flaw_app");
    expect(await appRoleEcarts(app)).toEqual([]);

    await owner.query("ALTER POLICY documents_owner ON flaw.documents USING (true) WITH CHECK (true)");
    expect((await appRoleEcarts(app)).some((ecart) => ecart.includes("politique documents"))).toBe(true);
    await owner.query(
      "ALTER POLICY documents_owner ON flaw.documents USING (owner_id = NULLIF(current_setting('app.user_id', true), '')::uuid) WITH CHECK (owner_id = NULLIF(current_setting('app.user_id', true), '')::uuid)",
    );
    expect(await appRoleEcarts(app)).toEqual([]);

    await admin.query("GRANT postgres TO flaw_owner");
    expect((await appRoleEcarts(app)).some((ecart) => ecart.startsWith("g2 flaw_owner"))).toBe(true);
    await admin.query("REVOKE postgres FROM flaw_owner");
    expect(await appRoleEcarts(app)).toEqual([]);

    await admin.query("CREATE TABLE flaw.intrus (id integer)");
    // Même script figé que migrate : le test G4 doit exécuter le fichier, pas une copie.
    await expect(owner.query(infraSql("droits-flaw.sql"))).rejects.toThrow(/hors flaw_owner|table inconnue/); // nosemgrep: sec-db-03-query-non-literal
    await owner.query("ROLLBACK");
    await admin.query("DROP TABLE flaw.intrus");
    await owner.query(infraSql("droits-flaw.sql")); // nosemgrep: sec-db-03-query-non-literal
    expect(await appRoleEcarts(app)).toEqual([]);
  });
});
