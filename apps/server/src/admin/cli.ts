/**
 * flaw-admin : check-roles, create-user --email, reset-password --email.
 * Le mot de passe provisoire est écrit une seule fois sur la sortie standard.
 */
import { pathToFileURL } from "node:url";
import { Client, Pool } from "pg";

import { openAuth } from "../auth/service.ts";
import { ARGON_TARGET } from "../auth/password.ts";
import { loadConfig } from "../config/load.ts";
import { writeSecurityLog } from "../platform/security-log.ts";
import { checkRoles } from "./check-roles.ts";

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  return import.meta.url === pathToFileURL(entry).href;
}

function emailFromArgs(argv: readonly string[]): string | null {
  const flag = argv.indexOf("--email");
  if (flag < 0) {
    return null;
  }
  const value = argv[flag + 1];
  if (value === undefined || value.startsWith("--")) {
    return null;
  }
  return value;
}

function databasePort(): number {
  const raw = process.env.DATABASE_PORT ?? "5432";
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("requête invalide");
  }
  return port;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const loaded = loadConfig(process.env);
  if (!loaded.ok) {
    console.error(loaded.message);
    process.exit(1);
  }
  const port = databasePort();
  if (command === "check-roles") {
    const client = new Client({
      host: loaded.config.DATABASE_HOST,
      port,
      database: loaded.config.DATABASE_NAME,
      user: loaded.config.DATABASE_USER,
      password: loaded.secrets.databasePassword,
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
    return;
  }
  if (command !== "create-user" && command !== "reset-password") {
    console.error("commande inconnue");
    process.exit(1);
  }
  const email = emailFromArgs(argv.slice(1));
  if (email === null) {
    console.error("requête invalide");
    process.exit(1);
  }
  const pool = new Pool({
    host: loaded.config.DATABASE_HOST,
    port,
    database: loaded.config.DATABASE_NAME,
    user: loaded.config.DATABASE_USER,
    password: loaded.secrets.databasePassword,
    max: 2,
    connectionTimeoutMillis: 5000,
  });
  try {
    const auth = openAuth({
      pool,
      pepper: loaded.secrets.hmacPepper,
      pepperId: loaded.config.HMAC_PEPPER_ID,
      minLength: loaded.config.PASSWORD_MIN_LENGTH,
      idleDays: loaded.config.SESSION_IDLE_DAYS,
      maxDays: loaded.config.SESSION_MAX_DAYS,
      argon: ARGON_TARGET,
      now: () => new Date(),
      onEvent: (event) => {
        writeSecurityLog(process.stderr, event);
      },
    });
    const password =
      command === "create-user"
        ? (await auth.createUser(email, "127.0.0.1")).password
        : await auth.resetPassword(email, "127.0.0.1");
    process.stdout.write(`${password}\n`);
  } finally {
    await pool.end();
  }
}

if (isDirectRun()) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "echec";
    console.error(message);
    process.exit(1);
  });
}
