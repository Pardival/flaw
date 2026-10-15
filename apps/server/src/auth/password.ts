/**
 * Politique NIST et argon2id (SEC-AUTH-01, SEC-AUTH-02).
 * Plancher m=19 Mio, t=2. Cible m=64 Mio, t=3. Aucun autre algorithme.
 */
import { createRequire } from "node:module";
import { randomBytes, randomInt } from "node:crypto";
import type { Options } from "@node-rs/argon2";

const require = createRequire(import.meta.url);
const argon2 = require("@node-rs/argon2") as {
  hash(password: string, options?: Options): Promise<string>;
  verify(hashed: string, password: string): Promise<boolean>;
  parseOptions(hashed: string): {
    algorithm: number;
    memoryCost: number;
    timeCost: number;
    parallelism: number;
  };
};

const ARGON2ID = 2;

export type ArgonParams = {
  m: number;
  t: number;
  p: number;
};

export const ARGON_FLOOR: ArgonParams = { m: 19456, t: 2, p: 1 };
export const ARGON_TARGET: ArgonParams = { m: 65536, t: 3, p: 1 };
export const PASSWORD_MIN_FLOOR = 8;
export const PASSWORD_MAX_LENGTH = 128;
const PROVISIONAL_LENGTH = 24;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

const COMMON_PASSWORDS = new Set([
  "password",
  "passwordpassword",
  "12345678",
  "123456789012345",
  "qwertyui",
  "qwertyuiopasdfg",
  "azertyazertyazerty",
  "motdepassemotdepasse",
  "administratoradmin",
  "letmeinletmeinlet",
  "iloveyouiloveyou1",
  "welcomewelcome123",
  "changemechangeme1",
  "adminadminadmin1",
  "passw0rdpassw0rd",
]);

export function assertPasswordMinLength(value: number): void {
  if (!Number.isInteger(value) || value < PASSWORD_MIN_FLOOR) {
    throw new Error("refus de démarrer : politique de mot de passe");
  }
}

export function assertArgonParams(params: ArgonParams): void {
  if (params.m < ARGON_FLOOR.m || params.t < ARGON_FLOOR.t || params.p < ARGON_FLOOR.p) {
    throw new Error("refus de démarrer : paramètres argon2id");
  }
}

export function codePointLength(value: string): number {
  return Array.from(value).length;
}

export type PasswordDecision = { ok: true; password: string } | { ok: false };

export function assessPassword(raw: string, minLength: number): PasswordDecision {
  const password = raw.normalize("NFC");
  const length = codePointLength(password);
  if (length < minLength || length > PASSWORD_MAX_LENGTH) {
    return { ok: false };
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return { ok: false };
  }
  return { ok: true, password };
}

export function provisionalPassword(): string {
  let out = "";
  for (let index = 0; index < PROVISIONAL_LENGTH; index += 1) {
    out += ALPHABET[randomInt(ALPHABET.length)];
  }
  return out;
}

export async function hashPassword(password: string, params: ArgonParams): Promise<string> {
  assertArgonParams(params);
  const hashed = await argon2.hash(password, {
    memoryCost: params.m,
    timeCost: params.t,
    parallelism: params.p,
    outputLen: 32,
    algorithm: ARGON2ID,
  } as Options);
  if (!hashed.startsWith("$argon2id$v=19$")) {
    throw new Error("hachage argon2id refusé");
  }
  return hashed;
}

export async function verifyPassword(password: string, hashed: string): Promise<boolean> {
  if (!hashed.startsWith("$argon2id$v=19$")) {
    return false;
  }
  try {
    return await argon2.verify(hashed, password);
  } catch {
    return false;
  }
}

export function passwordNeedsRehash(hashed: string, target: ArgonParams): boolean {
  if (!hashed.startsWith("$argon2id$v=19$")) {
    return true;
  }
  try {
    const parsed = argon2.parseOptions(hashed);
    return (
      parsed.algorithm !== ARGON2ID ||
      parsed.memoryCost < target.m ||
      parsed.timeCost < target.t ||
      parsed.parallelism < target.p
    );
  } catch {
    return true;
  }
}

export function dummyPasswordMaterial(): string {
  return randomBytes(32).toString("base64url");
}
