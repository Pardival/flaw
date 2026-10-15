import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";

import { CryptoError } from "./errors.ts";

/** XChaCha20-Poly1305, enc_version 1 (SEC-DATA-05, A-013). */
export const ENC_VERSION = 1;
export const KEY_LENGTH = 32;
export const NONCE_LENGTH = 24;
export const TAG_LENGTH = 16;

type WebCryptoRandom = {
  getRandomValues?: (bytes: Uint8Array) => Uint8Array;
};

export function randomBytes(length: number): Uint8Array {
  if (!Number.isInteger(length) || length < 1) {
    throw new CryptoError("invalid_length");
  }
  const webCrypto = (globalThis as { crypto?: WebCryptoRandom }).crypto;
  if (webCrypto?.getRandomValues === undefined) {
    throw new CryptoError("csprng_absent");
  }
  const bytes = new Uint8Array(length);
  webCrypto.getRandomValues(bytes);
  return bytes;
}

export function assertKey(key: Uint8Array): void {
  if (key.length !== KEY_LENGTH) {
    throw new CryptoError("invalid_key_length");
  }
}

/**
 * XChaCha20-Poly1305 (@noble/ciphers). Nonce 192 bits.
 * Le tag Poly1305 (16 octets) est concaténé au chiffré.
 */
export function sealXChaCha(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  assertKey(key);
  if (nonce.length !== NONCE_LENGTH) {
    throw new CryptoError("invalid_nonce");
  }
  return xchacha20poly1305(key, nonce, aad).encrypt(plaintext);
}

export function openXChaCha(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  assertKey(key);
  if (nonce.length !== NONCE_LENGTH) {
    throw new CryptoError("invalid_nonce");
  }
  if (ciphertext.length < TAG_LENGTH) {
    throw new CryptoError("invalid_ciphertext");
  }
  try {
    return xchacha20poly1305(key, nonce, aad).decrypt(ciphertext);
  } catch {
    throw new CryptoError("authentication_failed");
  }
}
