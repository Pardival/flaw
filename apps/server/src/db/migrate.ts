/**
 * Service migrate (T-005). Connexion flaw_app, puis migrations Drizzle.
 * Le rôle de migration distinct (SEC-DB-02, avant public) n'est pas créé :
 * l'arbitrage T-002 #5 fixe migrate sur flaw_app en v1.
 * Le journal Drizzle est dans le schéma flaw.
 * migrate() exécute CREATE SCHEMA IF NOT EXISTS : PostgreSQL 18 exige CREATE
 * sur la base, accordé à flaw_app par initdb. Un rôle DDL distinct (avant public)
 * retirera ce droit du rôle d'exécution.
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

export function migrationsFolder(): string {
  return fileURLToPath(new URL("../../drizzle", import.meta.url));
}

export async function assertAppRole(client: Client): Promise<void> {
  const result = await client.query<RoleRow>(
    "SELECT current_user AS current_user, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = current_user",
  );
  const row = result.rows[0];
  if (row === undefined || row.current_user !== "flaw_app") {
    throw new Error("refus de démarrer : role inattendu");
  }
  if (row.rolsuper || row.rolcreatedb || row.rolcreaterole || row.rolreplication || row.rolbypassrls) {
    throw new Error("refus de démarrer : privileges inattendus");
  }
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

async function connectApp(): Promise<Client> {
  const passwordFile = process.env.DATABASE_PASSWORD_FILE ?? "/run/secrets/app_db_password";
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
      user: process.env.DATABASE_USER ?? "flaw_app",
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
  const client = await connectApp();
  try {
    await assertAppRole(client);
    await applyMigrations(client);
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
