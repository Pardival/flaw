/**
 * Service migrate (T-005). Connexion flaw_owner, puis migrations Drizzle.
 * L'arbitrage T-002 #5 est annulé : flaw_app ne migre plus.
 * Le journal Drizzle est dans le schéma flaw. flaw_owner a CREATE sur la base,
 * exigé par migrate() (CREATE SCHEMA IF NOT EXISTS) sous PostgreSQL 18.
 * flaw_app reste en DML : le journal et sa séquence lui sont retirés.
 */
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readSecretFile } from "../platform/healthz.ts";

type RoleRow = {
  current_user: string;
  rolsuper: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
};

type CountRow = {
  n: number;
};

export function migrationsFolder(): string {
  return fileURLToPath(new URL("../../drizzle", import.meta.url));
}

async function roleRow(client: Client): Promise<RoleRow> {
  const result = await client.query<RoleRow>(
    "SELECT current_user AS current_user, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = current_user",
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("refus de démarrer : role inattendu");
  }
  return row;
}

function assertNotElevated(row: RoleRow): void {
  if (row.rolsuper || row.rolcreatedb || row.rolcreaterole || row.rolreplication || row.rolbypassrls) {
    throw new Error("refus de démarrer : privileges inattendus");
  }
}

export async function assertNoAppOwnedTables(client: Client): Promise<void> {
  const owned = await client.query<CountRow>(
    "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'flaw' AND tableowner = 'flaw_app'",
  );
  if (owned.rows[0]?.n !== 0) {
    throw new Error("refus de démarrer : table appartenant a flaw_app");
  }
}

export async function assertAppRole(client: Client): Promise<void> {
  const row = await roleRow(client);
  if (row.current_user !== "flaw_app") {
    throw new Error("refus de démarrer : role inattendu");
  }
  assertNotElevated(row);
  await assertNoAppOwnedTables(client);
}

export async function assertOwnerRole(client: Client): Promise<void> {
  const row = await roleRow(client);
  if (row.current_user !== "flaw_owner") {
    throw new Error("refus de démarrer : role inattendu");
  }
  assertNotElevated(row);
}

export async function applyMigrations(client: Client): Promise<void> {
  const db = drizzle(client);
  await migrate(db, {
    migrationsFolder: migrationsFolder(),
    migrationsSchema: "flaw",
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectOwner(): Promise<Client> {
  const passwordFile = process.env.DATABASE_PASSWORD_FILE ?? "/run/secrets/db_owner_password";
  const secret = readSecretFile(passwordFile, "secret");
  if (!secret.ok) {
    throw new Error(secret.message);
  }
  const deadline = Date.now() + 45_000;
  let last = "base injoignable";
  while (Date.now() < deadline) {
    const client = new Client({
      host: process.env.DATABASE_HOST ?? "db",
      port: 5432,
      database: process.env.DATABASE_NAME ?? "flaw",
      user: process.env.DATABASE_USER ?? "flaw_owner",
      password: secret.value,
      connectionTimeoutMillis: 3000,
    });
    try {
      await client.connect();
      return client;
    } catch (error) {
      last = error instanceof Error ? error.message : "echec";
      await client.end().catch(() => undefined);
      await delay(1000);
    }
  }
  throw new Error(`refus de démarrer : ${last}`);
}

async function main(): Promise<void> {
  const client = await connectOwner();
  try {
    await assertOwnerRole(client);
    await applyMigrations(client);
    await assertNoAppOwnedTables(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "echec";
    console.error(message.startsWith("refus de démarrer") ? message : `refus de démarrer : ${message}`);
    process.exit(1);
  });
}
