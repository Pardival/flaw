import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

import { utf8 } from "./bytes.ts";
import { CryptoError } from "./errors.ts";
import { KEY_LENGTH } from "./aead.ts";

/**
 * Dérivations HKDF-SHA-256 (T-006).
 *
 * Sel : le paquet fixe l'info, pas le sel. Sel omis ou vide → RFC 5869 §2.2
 * (HashLen octets nuls). Choix provisoire, signalé.
 * Longueur des clés d'usage : 32 octets (HMAC-SHA-256 ; code_hmac T-005 = 32).
 *
 * Identifiants : info = « flaw/hmac-identifiants/v1| » ‖ HMAC_PEPPER_ID.
 * Codes de secours (G13/H1) : le paquet ne donne pas le littéral. Le schéma
 * T-005 le fixe : info = « flaw/recovery-codes/v1| » ‖ pepper_id.
 * IKM = 32 octets décodés du secret (même forme que la KEK).
 */
export const HMAC_IDENTIFIERS_INFO_PREFIX = "flaw/hmac-identifiants/v1|";
export const RECOVERY_CODES_INFO_PREFIX = "flaw/recovery-codes/v1|";
export const DERIVED_KEY_LENGTH = KEY_LENGTH;

export function hkdfSha256(
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
  salt?: Uint8Array,
): Uint8Array {
  if (!Number.isInteger(length) || length < 0) {
    throw new CryptoError("invalid_length");
  }
  const saltArg = salt === undefined || salt.length === 0 ? undefined : salt;
  return hkdf(sha256, ikm, saltArg, info, length);
}

function infoBytes(prefix: string, id: string): Uint8Array {
  if (id.length === 0 || id.includes("\0")) {
    throw new CryptoError("invalid_binding");
  }
  return utf8(`${prefix}${id}`);
}

function assertPepper(pepper: Uint8Array): void {
  if (pepper.length !== KEY_LENGTH) {
    throw new CryptoError("invalid_key_length");
  }
}

export function deriveIdentifierHmacKey(pepper: Uint8Array, pepperId: string): Uint8Array {
  assertPepper(pepper);
  return hkdfSha256(pepper, infoBytes(HMAC_IDENTIFIERS_INFO_PREFIX, pepperId), DERIVED_KEY_LENGTH);
}

export function deriveRecoveryCodeKey(pepper: Uint8Array, pepperId: string): Uint8Array {
  assertPepper(pepper);
  return hkdfSha256(pepper, infoBytes(RECOVERY_CODES_INFO_PREFIX, pepperId), DERIVED_KEY_LENGTH);
}
