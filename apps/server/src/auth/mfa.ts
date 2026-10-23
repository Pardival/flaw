/**
 * TOTP RFC 6238 (HMAC-SHA-1, 6 chiffres, pas de 30 s, fenêtre ±1).
 * A-012 (ARC-SUM 0.4.18) : le rejeu d'un même pas est refusé.
 * Codes de secours 80 bits, base32, HMAC-SHA-256 (AC-063 à AC-066).
 * Le secret TOTP est chiffré sous la DEK. Le code de secours n'est jamais stocké :
 * seul son HMAC l'est. rotate-kek ne touche pas ces HMAC.
 */
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

import { deriveRecoveryCodeKey } from "@flaw/crypto";

const STEP_SECONDS = 30;
const DIGITS = 6;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function hotp(secret: Uint8Array, counter: number, digits = DIGITS): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", secret).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export function totpStep(at: Date): number {
  return Math.floor(at.getTime() / 1000 / STEP_SECONDS);
}

function sameText(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Fenêtre ±1 autour de `at`. Le pas déjà accepté (`lastStep`) ne peut pas
 * être rejoué, y compris tant qu'il reste dans la fenêtre.
 * Un pas strictement antérieur est refusé aussi : un code du bord inférieur,
 * déjà observable, ne doit pas passer après l'acceptation d'un pas plus récent.
 * Un pas ultérieur de la fenêtre reste accepté.
 */
export function matchTotp(secret: Uint8Array, code: string, at: Date, lastStep: number | null): number | null {
  if (!/^\d{6}$/.test(code)) {
    return null;
  }
  const step = totpStep(at);
  for (const candidate of [step - 1, step, step + 1]) {
    if (candidate < 0) {
      continue;
    }
    if (lastStep !== null && candidate <= lastStep) {
      continue;
    }
    if (sameText(hotp(secret, candidate, DIGITS), code)) {
      return candidate;
    }
  }
  return null;
}

export function encodeBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32[(value >> bits) & 31];
    }
  }
  if (bits > 0) {
    out += BASE32[(value << (5 - bits)) & 31];
  }
  return out;
}

export function decodeBase32(text: string): Uint8Array | null {
  const clean = text.replace(/=+$/u, "").toUpperCase();
  if (clean.length === 0 || [...clean].some((char) => !BASE32.includes(char))) {
    return null;
  }
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/** 16 caractères base32 (80 bits), groupés XXXX-XXXX-XXXX-XXXX. */
export function recoveryCode(): string {
  let raw = "";
  for (let index = 0; index < 16; index += 1) {
    raw += BASE32[randomInt(BASE32.length)];
  }
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
}

export function normalizeRecoveryCode(code: string): string | null {
  const compact = code.normalize("NFC").replace(/-/g, "").toUpperCase();
  if (!/^[A-Z2-7]{16}$/.test(compact)) {
    return null;
  }
  return compact;
}

export function recoveryCodeHmac(pepper: Uint8Array, pepperId: string, userId: string, code: string): Buffer | null {
  const normalized = normalizeRecoveryCode(code);
  if (normalized === null) {
    return null;
  }
  const key = Buffer.from(deriveRecoveryCodeKey(pepper, pepperId));
  try {
    return createHmac("sha256", key).update(`${userId}${normalized}`, "utf8").digest();
  } finally {
    key.fill(0);
  }
}
