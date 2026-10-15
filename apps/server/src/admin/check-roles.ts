/**
 * flaw-admin check-roles : rôles, propriétaires et droits du tableau T-005.
 * La requête est infra/assert-app-role.sql (0 ligne = conforme).
 */
import { Client } from "pg";
import { pathToFileURL } from "node:url";

import { appRoleEcarts } from "../db/migrate.ts";
import { readSecretFile } from "../platform/healthz.ts";

export async function checkRoles(client: Client): Promise<string[]> {
  return appRoleEcarts(client);
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  return import.meta.url === pathToFileURL(entry).href;
}

async function main(): Promise<void> {
  const passwordFile = process.env.DATABASE_PASSWORD_FILE ?? "/run/secrets/app_db_password";
  const secret = readSecretFile(passwordFile, "secret");
  if (!secret.ok) {
    console.error(secret.message);
    process.exit(1);
  }
  const client = new Client({
    host: process.env.DATABASE_HOST ?? "db",
    port: Number(process.env.DATABASE_PORT ?? 5432),
    database: process.env.DATABASE_NAME ?? "flaw",
    user: process.env.DATABASE_USER ?? "flaw_app",
    password: secret.value,
  });
  await client.connect();
  try {
    const ecarts = await checkRoles(client);
    if (ecarts.length === 0) {
      process.stdout.write("rôles conformes\n");
      return;
    }
    for (const ecart of ecarts) {
      process.stderr.write(`${ecart}\n`);
    }
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

if (isDirectRun()) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "echec";
    console.error(message.startsWith("refus de démarrer") ? message : "refus de démarrer");
    process.exit(1);
  });
}
