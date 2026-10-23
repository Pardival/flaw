/**
 * flaw-admin : create-user, reset-password, disable-mfa, revoke-sessions,
 * revoke-dek, rotate-kek, check-roles, replay-erasures.
 * Le mot de passe provisoire sort une seule fois sur stdout, jamais dans le journal.
 * replay-erasures est exposée ici ; sa logique et ses alertes relèvent de T-051.
 * Les alertes de check-roles relèvent de T-007.
 */
import { pathToFileURL } from "node:url";
import { Client, Pool } from "pg";
import type { Writable } from "node:stream";

import { checkRoles } from "../admin/check-roles.ts";
import { openAuth } from "../auth/service.ts";
import { ARGON_TARGET } from "../auth/password.ts";
import { findAccount, insertAudit, type Sql } from "../auth/store.ts";
import { decodeValidatedKey, loadKekFile, sameKeyBytes } from "../crypto/kek.ts";
import { loadConfig, type LoadResult } from "../config/load.ts";
import { writeSecurityLog } from "../platform/security-log.ts";
import { alertAdmin } from "./alert.ts";
import { revokeDek } from "./revoke-dek.ts";
import { rotateAllDeks } from "./rotate-kek.ts";

type Io = {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  stdout: Writable;
  stderr: Writable;
};

type Ready = Extract<LoadResult, { ok: true }>;

function flag(argv: readonly string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index < 0) {
    return null;
  }
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    return null;
  }
  return value;
}

function databasePort(env: NodeJS.ProcessEnv): number {
  const raw = env.DATABASE_PORT ?? "5432";
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("requête invalide");
  }
  return port;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/u, "");
}

function keysConflict(oldKek: Uint8Array, newKek: Uint8Array, hmacPepper: string, recoveryPepper: string): boolean {
  const peppers = [hmacPepper, recoveryPepper].map((value) => decodeValidatedKey(value));
  try {
    if (sameKeyBytes(oldKek, newKek)) {
      return true;
    }
    return peppers.some((pepper) => pepper !== null && sameKeyBytes(newKek, pepper));
  } finally {
    for (const pepper of peppers) {
      pepper?.fill(0);
    }
  }
}

function rotateSuccessMessage(newId: string): string {
  return [
    "kek tournée, retirer l'ancien secret",
    "L'ancienne KEK a le statut retired : elle ne sert plus à chiffrer et reste disponible pour déchiffrer jusqu'à la fin de la rétention des sauvegardes. Aucun fichier n'a été supprimé.",
    `Installez le nouveau secret à la place de flaw_kek, réglez FLAW_KEK_ID=${newId}, redémarrez l'application, puis vérifiez une connexion.`,
    "La destruction planifiée de l'ancienne KEK est hors périmètre (T-042).",
    "",
  ].join("\n");
}

async function auditFailure(sql: Sql, action: string, email: string | null): Promise<void> {
  let userId: string | null = null;
  if (email !== null) {
    const account = await findAccount(sql, email.normalize("NFC").trim().toLowerCase());
    userId = account?.user_id ?? null;
  }
  if (userId === null) {
    const any = await sql.query<{ id: string }>("SELECT id FROM flaw.users LIMIT 1");
    userId = any.rows[0]?.id ?? null;
  }
  if (userId === null) {
    return;
  }
  await insertAudit(sql, userId, action, "erreur");
}

function poolFor(loaded: Ready, port: number): Pool {
  return new Pool({
    host: loaded.config.DATABASE_HOST,
    port,
    database: loaded.config.DATABASE_NAME,
    user: loaded.config.DATABASE_USER,
    password: loaded.secrets.databasePassword,
    max: 2,
    connectionTimeoutMillis: 5000,
  });
}

export async function main(options: Partial<Io> = {}): Promise<number> {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const command = argv[0];
  const loaded = loadConfig(env);
  if (!loaded.ok) {
    stderr.write(`${loaded.message}\n`);
    return 1;
  }
  const port = databasePort(env);
  if (command === "check-roles") {
    return runCheckRoles(loaded, port, stdout, stderr);
  }
  if (command === "replay-erasures") {
    writeSecurityLog(stderr, {
      type: "admin_action",
      result: "echec",
      ip: null,
      userAgent: null,
      action: "admin.replay_erasures",
    });
    stderr.write("non implémenté (T-051)\n");
    try {
      const pool = poolFor(loaded, port);
      try {
        await auditFailure(pool, "admin.replay_erasures", null);
      } finally {
        await pool.end();
      }
    } catch {
      // L'audit ne masque pas le code de sortie.
    }
    return 1;
  }
  if (command === "rotate-kek") {
    return runRotate(loaded, port, argv, env, stdout, stderr);
  }
  if (command === "revoke-dek") {
    return runRevokeDek(loaded, port, argv, stdout, stderr);
  }
  if (
    command !== "create-user" &&
    command !== "reset-password" &&
    command !== "disable-mfa" &&
    command !== "revoke-sessions"
  ) {
    stderr.write("commande inconnue\n");
    return 1;
  }
  const email = flag(argv, "--email");
  if (email === null) {
    stderr.write("requête invalide\n");
    return 1;
  }
  const chosen = argv.includes("--password-stdin") ? await readStdin() : undefined;
  const pool = poolFor(loaded, port);
  const action =
    command === "create-user"
      ? "admin.create_user"
      : command === "reset-password"
        ? "admin.reset_password"
        : command === "disable-mfa"
          ? "admin.disable_mfa"
          : "admin.revoke_sessions";
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
        writeSecurityLog(stderr, event);
      },
    });
    try {
      if (command === "revoke-sessions") {
        await auth.revokeSessions(email, "127.0.0.1");
        await alertAdmin(loaded.config.ALERT_WEBHOOK_URL, "admin.revoke_sessions");
        stdout.write("sessions révoquées\n");
        return 0;
      }
      const password =
        command === "create-user"
          ? (await auth.createUser(email, "127.0.0.1", chosen)).password
          : command === "reset-password"
            ? await auth.resetPassword(email, "127.0.0.1", chosen)
            : await auth.disableMfa(email, "127.0.0.1", chosen);
      await alertAdmin(loaded.config.ALERT_WEBHOOK_URL, action);
      stdout.write(`${password}\n`);
      return 0;
    } catch (error) {
      writeSecurityLog(stderr, {
        type: "admin_action",
        result: "echec",
        ip: null,
        userAgent: null,
        action,
      });
      try {
        await auditFailure(pool, action, email);
      } catch {
        // L'audit ne masque pas le code de sortie.
      }
      const message = error instanceof Error ? error.message : "echec";
      stderr.write(`${message}\n`);
      return 1;
    }
  } finally {
    await pool.end();
  }
}

async function runCheckRoles(loaded: Ready, port: number, stdout: Writable, stderr: Writable): Promise<number> {
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
    writeSecurityLog(stderr, {
      type: "admin_action",
      result: ecarts.length === 0 ? "succes" : "echec",
      ip: null,
      userAgent: null,
      action: "admin.check_roles",
    });
    if (ecarts.length === 0) {
      stdout.write("rôles conformes\n");
      return 0;
    }
    try {
      await auditFailure(client, "admin.check_roles", null);
    } catch {
      // L'audit ne masque pas le code de sortie.
    }
    for (const ecart of ecarts) {
      stderr.write(`${ecart}\n`);
    }
    return 1;
  } finally {
    await client.end();
  }
}

async function runRotate(
  loaded: Ready,
  port: number,
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  const newId = flag(argv, "--kek-id");
  const newFile = flag(argv, "--new-kek-file");
  const oldFile = env.FLAW_KEK_FILE ?? "/run/secrets/flaw_kek";
  if (newId === null || newFile === null || newFile === oldFile) {
    stderr.write("requête invalide\n");
    return 1;
  }
  if (newId === loaded.config.FLAW_KEK_ID) {
    stderr.write("kek inattendue\n");
    return 1;
  }
  const oldLoaded = loadKekFile(oldFile);
  const newLoaded = loadKekFile(newFile);
  if (!oldLoaded.ok || !newLoaded.ok) {
    if (oldLoaded.ok) {
      oldLoaded.kek.fill(0);
    }
    if (newLoaded.ok) {
      newLoaded.kek.fill(0);
    }
    stderr.write("refus de démarrer : kek\n");
    if (!newLoaded.ok && newLoaded.message.includes("lisible par tous")) {
      stderr.write("la nouvelle KEK doit être en mode 0400\n");
    }
    return 1;
  }
  if (keysConflict(oldLoaded.kek, newLoaded.kek, loaded.secrets.hmacPepper, loaded.secrets.recoveryPepper)) {
    oldLoaded.kek.fill(0);
    newLoaded.kek.fill(0);
    stderr.write("refus de démarrer : kek\n");
    return 1;
  }
  const pool = poolFor(loaded, port);
  try {
    const owners = await rotateAllDeks(pool, oldLoaded.kek, loaded.config.FLAW_KEK_ID, newLoaded.kek, newId);
    for (const owner of owners) {
      await insertAudit(pool, owner, "admin.rotate_kek", "ok");
    }
    writeSecurityLog(stderr, {
      type: "admin_action",
      result: "succes",
      ip: null,
      userAgent: null,
      action: "admin.rotate_kek",
    });
    await alertAdmin(loaded.config.ALERT_WEBHOOK_URL, "admin.rotate_kek");
    stdout.write(rotateSuccessMessage(newId));
    return 0;
  } catch (error) {
    writeSecurityLog(stderr, {
      type: "admin_action",
      result: "echec",
      ip: null,
      userAgent: null,
      action: "admin.rotate_kek",
    });
    try {
      await auditFailure(pool, "admin.rotate_kek", null);
    } catch {
      // L'audit ne masque pas le code de sortie.
    }
    const message = error instanceof Error ? error.message : "echec";
    stderr.write(`${message}\n`);
    return 1;
  } finally {
    oldLoaded.kek.fill(0);
    newLoaded.kek.fill(0);
    await pool.end();
  }
}

async function runRevokeDek(
  loaded: Ready,
  port: number,
  argv: readonly string[],
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  const email = flag(argv, "--email");
  const dekId = flag(argv, "--dek-id");
  if (email === null || dekId === null) {
    stderr.write("requête invalide\n");
    return 1;
  }
  const pool = poolFor(loaded, port);
  try {
    const account = await findAccount(pool, email.normalize("NFC").trim().toLowerCase());
    if (account === null) {
      writeSecurityLog(stderr, {
        type: "admin_action",
        result: "echec",
        ip: null,
        userAgent: null,
        action: "admin.revoke_dek",
      });
      try {
        await auditFailure(pool, "admin.revoke_dek", null);
      } catch {
        // L'audit ne masque pas le code de sortie.
      }
      stderr.write("compte introuvable\n");
      return 1;
    }
    const revoked = await revokeDek(pool, account.user_id, dekId, stderr);
    if (!revoked) {
      writeSecurityLog(stderr, {
        type: "admin_action",
        result: "echec",
        ip: null,
        userAgent: null,
        action: "admin.revoke_dek",
      });
      try {
        await auditFailure(pool, "admin.revoke_dek", email);
      } catch {
        // L'audit ne masque pas le code de sortie.
      }
      stderr.write("dek introuvable\n");
      return 1;
    }
    await alertAdmin(loaded.config.ALERT_WEBHOOK_URL, "admin.revoke_dek");
    stdout.write("dek révoquée\n");
    return 0;
  } catch (error) {
    writeSecurityLog(stderr, {
      type: "admin_action",
      result: "echec",
      ip: null,
      userAgent: null,
      action: "admin.revoke_dek",
    });
    try {
      await auditFailure(pool, "admin.revoke_dek", email);
    } catch {
      // L'audit ne masque pas le code de sortie.
    }
    const message = error instanceof Error ? error.message : "echec";
    stderr.write(`${message}\n`);
    return 1;
  } finally {
    await pool.end();
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
  main()
    .then((code) => {
      process.exit(code);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "echec";
      process.stderr.write(`${message}\n`);
      process.exit(1);
    });
}
