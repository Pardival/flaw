/**
 * T-005 — AC-095, AC-096, AC-102, SEC-DB-02, SEC-DB-03, SEC-DB-05, SEC-DATA-01.
 * Postgres 18.6 épinglé, le même digest que infra/docker-compose.yml.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Client } from "pg";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, assertAppRole } from "./migrate.ts";
import { APP_USER_PREDICATE, OWNER_TABLES, RLS_TABLES, TABLE_NAMES } from "./schema.ts";

const POSTGRES_IMAGE =
  "postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873";
const DB_PASSWORD = "0123456789abcdef0123456789abcdef";
const INJECTION = "' OR 1=1 --";
const TRACKERS = ["google-analytics", "googletagmanager", "segment.io", "plausible.io"];

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

  it("crée les 16 tables et force la RLS (SEC-DB-05, A-014)", () => {
    expect(TABLE_NAMES).toHaveLength(16);
    for (const name of TABLE_NAMES) {
      expect(migration).toContain(`CREATE TABLE flaw.${name} (`);
    }
    for (const name of RLS_TABLES) {
      expect(migration).toContain(`ALTER TABLE flaw.${name} ENABLE ROW LEVEL SECURITY;`);
      expect(migration).toContain(`ALTER TABLE flaw.${name} FORCE ROW LEVEL SECURITY;`);
    }
    expect(migration).toContain(APP_USER_PREDICATE);
    expect(migration).not.toContain("verifications ENABLE ROW LEVEL SECURITY");
    expect(migration).not.toContain("rate_limits ENABLE ROW LEVEL SECURITY");
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

  it("branche le service migrate sur la même commande Compose (AC-095)", () => {
    expect(compose).toContain(POSTGRES_IMAGE);
    expect(compose).toContain('command: ["node", "apps/server/src/db/migrate.ts"]');
    expect(compose).toContain("DATABASE_USER: flaw_app");
    expect(dockerfile).toContain("COPY --from=build /src/apps/server/drizzle /app/apps/server/drizzle");
  });
});

describe("rôle flaw_app, RLS et requêtes paramétrées", () => {
  let admin: Client;
  let app: Client;
  let db: Database;
  let port = 0;

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
    const existing = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = 'flaw_app'");
    if (existing.rows.length === 0) {
      await admin.query(
        "CREATE ROLE flaw_app LOGIN PASSWORD '0123456789abcdef0123456789abcdef' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS",
      );
    }
    await admin.query("REVOKE ALL ON SCHEMA public FROM PUBLIC");
    await admin.query("CREATE SCHEMA IF NOT EXISTS flaw AUTHORIZATION flaw_app");
    await admin.query("ALTER ROLE flaw_app SET search_path = flaw");
    await admin.query("GRANT CONNECT ON DATABASE flaw TO flaw_app");
    await admin.query("GRANT CREATE ON DATABASE flaw TO flaw_app");
    await admin.end();

    app = await connectStable("flaw_app");
    await assertAppRole(app);
    await applyMigrations(app);
    db = drizzle(app);
  }, 180_000);

  afterAll(async () => {
    await app?.end().catch(() => undefined);
    docker(["rm", "-f", container]);
  });

  it("refuse le superutilisateur et isole deux comptes (SEC-DB-02, SEC-DB-05, SEC-DATA-01, AC-096)", async () => {
    await assertAppRole(app);

    const catalog = rowsOf(
      await db.execute(sql`
        select c.relname as name
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'flaw'
          and c.relkind = 'r'
          and c.relname <> '__drizzle_migrations'
        order by c.relname
      `),
    );
    expect(catalog.map((row) => String(row.name)).sort()).toEqual([...TABLE_NAMES].sort());

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
        where n.nspname = 'flaw' and c.relkind = 'r' and c.relname <> '__drizzle_migrations'
      `),
    );
    const flagByName = new Map(flags.map((row) => [String(row.name), row]));
    for (const name of RLS_TABLES) {
      expect(flagByName.get(name)?.enabled, name).toBe(true);
      expect(flagByName.get(name)?.forced, name).toBe(true);
    }
    expect(flagByName.get("verifications")?.enabled).toBe(false);
    expect(flagByName.get("rate_limits")?.enabled).toBe(false);

    const policies = rowsOf(
      await db.execute(sql`
        select c.relname as name, pg_get_expr(p.polqual, p.polrelid) as using_expr
        from pg_policy p
        join pg_class c on c.oid = p.polrelid
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'flaw'
      `),
    );
    expect(policies).toHaveLength(RLS_TABLES.length);
    for (const policy of policies) {
      const expression = String(policy.using_expr);
      expect(expression).toContain("NULLIF");
      expect(expression).toContain("current_setting('app.user_id'");
      expect(expression).toContain("::uuid");
    }

    const userA = crypto.randomUUID();
    const userB = crypto.randomUUID();
    const adminId = crypto.randomUUID();

    await withUser(db, userA, async (tx) => {
      await tx.execute(sql`insert into flaw.users (id, role) values (${userA}, 'user')`);
      const inserted = rowsOf(
        await tx.execute(sql`
          insert into flaw.documents (owner_id, mode, format, font, projection)
          values (${userA}, 'prose', 'plain', 'serif', ''::bytea)
          returning id
        `),
      );
      const documentId = String(inserted[0]?.id);
      expect(documentId.charAt(14)).toBe("4");
      await tx.execute(sql`
        insert into flaw.document_states (document_id, owner_id, ciphertext)
        values (${documentId}, ${userA}, ''::bytea)
      `);
      await tx.execute(sql`
        insert into flaw.user_preferences (owner_id) values (${userA})
      `);
    });

    await withUser(db, userB, async (tx) => {
      await tx.execute(sql`insert into flaw.users (id, role) values (${userB}, 'user')`);
      await tx.execute(sql`
        insert into flaw.documents (owner_id, mode, format, font, projection)
        values (${userB}, 'verse', 'fountain', 'mono', ''::bytea)
      `);
    });

    await withUser(db, adminId, async (tx) => {
      await tx.execute(sql`insert into flaw.users (id, role) values (${adminId}, 'admin')`);
    });

    const seenByB = rowsOf(
      await withUser(db, userB, async (tx) => tx.execute(sql`select id, mode from flaw.documents`)),
    );
    expect(seenByB).toHaveLength(1);
    expect(seenByB[0]?.mode).toBe("verse");

    const seenByAdmin = rowsOf(
      await withUser(db, adminId, async (tx) => tx.execute(sql`select id from flaw.documents`)),
    );
    expect(seenByAdmin).toHaveLength(0);

    const withoutUser = rowsOf(await db.execute(sql`select id from flaw.documents`));
    expect(withoutUser).toHaveLength(0);

    const emptySetting = rowsOf(
      await db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.user_id', '', true)`);
        return tx.execute(sql`select id from flaw.documents`);
      }),
    );
    expect(emptySetting).toHaveLength(0);

    const statesOfASeenByB = rowsOf(
      await withUser(
        db,
        userB,
        async (tx) => tx.execute(sql`select document_id from flaw.document_states`),
      ),
    );
    expect(statesOfASeenByB).toHaveLength(0);

    const prefsOfA = rowsOf(
      await withUser(db, userA, async (tx) => tx.execute(sql`select browser_spellcheck from flaw.user_preferences`)),
    );
    expect(prefsOfA).toHaveLength(1);
    expect(prefsOfA[0]?.browser_spellcheck).toBe(false);

    await expect(
      withUser(db, userB, async (tx) =>
        tx.execute(sql`
          insert into flaw.documents (owner_id, mode, format, font, projection)
          values (${userA}, 'prose', 'plain', 'serif', ''::bytea)
        `),
      ),
    ).rejects.toThrow();
  }, 60_000);

  it("ignore une injection dans le filtre, l'identifiant et le tri (SEC-DB-03)", async () => {
    const userA = crypto.randomUUID();
    await withUser(db, userA, async (tx) => {
      await tx.execute(sql`insert into flaw.users (id, role) values (${userA}, 'user')`);
      await tx.execute(sql`
        insert into flaw.documents (owner_id, mode, format, font, projection)
        values (${userA}, 'prose', 'plain', 'serif', ''::bytea)
      `);
    });

    const byTitle = rowsOf(
      await withUser(db, userA, async (tx) =>
        tx.execute(sql`select id from flaw.documents where mode = ${INJECTION}`),
      ),
    );
    expect(byTitle).toHaveLength(0);

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
    expect(ordered).toHaveLength(1);
    expect(ordered[0]?.mode).toBe("prose");
  });

  it("réapplique la migration sans changer le schéma", async () => {
    await applyMigrations(app);
    const again = rowsOf(
      await db.execute(sql`
        select count(*)::int as n
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'flaw' and c.relkind = 'r' and c.relname <> '__drizzle_migrations'
      `),
    );
    expect(Number(again[0]?.n)).toBe(16);
  });
});
