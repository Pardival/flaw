/**
 * API-023 — GET /api/v1/healthz, et vérification migrate (arbitrage 11).
 * Validateur SEC-SECRET-07 : identique à infra/initdb/secret-valide.inc.
 * Seul le \r\n ou le \n final est retiré. Longueur et caractères distincts : octets UTF-8.
 * Aucun secret n'est écrit dans les messages.
 */
import { Buffer } from "node:buffer";
import { readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { Client } from "pg";

const FORBIDDEN = [
  "change",
  "example",
  "exemple",
  "password",
  "motdepasse",
  "secret",
  "default",
  "todo",
  "xxx",
  "test",
  "dummy",
  "sample",
  "flaw",
  "postgres",
  "admin",
  "restic",
] as const;

export type SecretKind = "secret" | "key";

export type SecretRead =
  | { ok: true; value: string }
  | { ok: false; message: string };

type RoleRow = {
  current_user: string;
  rolsuper: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
};

/** Retire un seul \r\n final, sinon un seul \n final. Aucun autre caractère. */
export function stripFinalNewline(value: string): string {
  if (value.endsWith("\r\n")) {
    return value.slice(0, -2);
  }
  if (value.endsWith("\n")) {
    return value.slice(0, -1);
  }
  return value;
}

/** Octets UTF-8 distincts. Même unité que secret_valide (awk, octets) dans creer-secrets.sh. */
function distinctOctets(value: string): number {
  return new Set(Buffer.from(value, "utf8")).size;
}

export function worldReadable(mode: number): boolean {
  return (mode & 0o007) !== 0;
}

export function validateSecret(raw: string): string | null {
  const value = stripFinalNewline(raw);
  if (value.includes("\r") || value.includes("\n")) {
    return "secret invalide";
  }
  if (Buffer.byteLength(value, "utf8") < 32) {
    return "secret invalide";
  }
  if (distinctOctets(value) < 16) {
    return "secret invalide";
  }
  const lower = value.toLowerCase();
  for (const word of FORBIDDEN) {
    if (lower.includes(word)) {
      return "secret invalide";
    }
  }
  return null;
}

export function validateKeyMaterial(raw: string): string | null {
  const common = validateSecret(raw);
  if (common !== null) {
    return common;
  }
  const value = stripFinalNewline(raw);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    return "kek";
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== value) {
    return "kek";
  }
  return null;
}

function errnoMessage(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
  if (code === "EACCES" || code === "EPERM") {
    return "refus de démarrer : EACCES";
  }
  return "refus de démarrer : secret absent";
}

export function readSecretFile(filePath: string, kind: SecretKind): SecretRead {
  let mode: number;
  try {
    mode = statSync(filePath).mode;
  } catch (error) {
    return { ok: false, message: errnoMessage(error) };
  }
  if (worldReadable(mode)) {
    return { ok: false, message: "refus de démarrer : secret lisible par tous" };
  }
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    return { ok: false, message: errnoMessage(error) };
  }
  const problem = kind === "key" ? validateKeyMaterial(raw) : validateSecret(raw);
  if (problem !== null) {
    return { ok: false, message: `refus de démarrer : ${problem}` };
  }
  return { ok: true, value: stripFinalNewline(raw) };
}

function normalizePeer(ip: string): string {
  return ip.toLowerCase().startsWith("::ffff:") ? ip.slice("::ffff:".length) : ip;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    return null;
  }
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    const octet = Number(part);
    if (octet > 255) {
      return null;
    }
    value = ((value << 8) | octet) >>> 0;
  }
  return value;
}

function inCidr(ip: string, cidr: string): boolean {
  const slash = cidr.indexOf("/");
  if (slash <= 0) {
    return false;
  }
  const base = cidr.slice(0, slash);
  const bits = Number(cidr.slice(slash + 1));
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) {
    return false;
  }
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base);
  if (ipInt === null || baseInt === null) {
    return false;
  }
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

export function resolvedClientIp(
  peer: string,
  xRealIp: string | undefined,
  cidr: string,
): string {
  const normalized = normalizePeer(peer);
  if (xRealIp !== undefined && inCidr(normalized, cidr) && ipv4ToInt(xRealIp) !== null) {
    return xRealIp;
  }
  return normalized;
}

function refuse(message: string): never {
  console.error(message);
  process.exit(1);
}

function mustSecret(filePath: string, kind: SecretKind): string {
  const result = readSecretFile(filePath, kind);
  if (!result.ok) {
    refuse(result.message);
  }
  return result.value;
}

async function verifyDatabase(password: string): Promise<void> {
  const deadline = Date.now() + 45_000;
  let last = "base injoignable";
  while (Date.now() < deadline) {
    const client = new Client({
      host: process.env.DATABASE_HOST ?? "db",
      port: 5432,
      database: process.env.DATABASE_NAME ?? "flaw",
      user: process.env.DATABASE_USER ?? "flaw_app",
      password,
      connectionTimeoutMillis: 3000,
    });
    try {
      await client.connect();
      const result = await client.query<RoleRow>(
        "SELECT current_user AS current_user, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      );
      const row = result.rows[0];
      if (row === undefined || row.current_user !== "flaw_app") {
        refuse("refus de démarrer : role inattendu");
      }
      if (
        row.rolsuper ||
        row.rolcreatedb ||
        row.rolcreaterole ||
        row.rolreplication ||
        row.rolbypassrls
      ) {
        refuse("refus de démarrer : privileges inattendus");
      }
      return;
    } catch (error) {
      last = error instanceof Error ? error.message : "echec";
    } finally {
      await client.end().catch(() => undefined);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  refuse(`refus de démarrer : ${last}`);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`${JSON.stringify(body)}\n`);
}

function handle(request: IncomingMessage, response: ServerResponse, cidr: string): void {
  const path = (request.url ?? "/").split("?")[0] ?? "/";
  if (request.method === "GET" && path === "/api/v1/healthz") {
    const peer = request.socket.remoteAddress ?? "";
    const rawHeader = request.headers["x-real-ip"];
    const header = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    sendJson(response, 200, {
      status: "ok",
      clientIp: resolvedClientIp(peer, header, cidr),
    });
    return;
  }
  sendJson(response, 404, { error: "not_found" });
}

function listen(port: number, cidr: string): void {
  createServer((request, response) => {
    handle(request, response, cidr);
  }).listen(port, "0.0.0.0");
}

async function main(): Promise<void> {
  const passwordFile = process.env.DATABASE_PASSWORD_FILE ?? "/run/secrets/app_db_password";
  if (process.argv.includes("migrate")) {
    await verifyDatabase(mustSecret(passwordFile, "secret"));
    return;
  }
  mustSecret(passwordFile, "secret");
  mustSecret(process.env.BETTER_AUTH_SECRET_FILE ?? "/run/secrets/better_auth_secret", "secret");
  mustSecret(process.env.FLAW_KEK_FILE ?? "/run/secrets/flaw_kek", "key");
  mustSecret(process.env.RECOVERY_PEPPER_FILE ?? "/run/secrets/recovery_pepper", "key");
  const port = Number(process.env.PORT ?? "3000");
  listen(port, process.env.TRUSTED_PROXY_CIDR ?? "");
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
    refuse(`refus de démarrer : ${message}`);
  });
}
