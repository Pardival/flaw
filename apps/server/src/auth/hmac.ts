/**
 * HMAC des identifiants. La clé vient de deriveIdentifierHmacKey (T-006) :
 * HKDF-SHA-256, sel omis, info « flaw/hmac-identifiants/v1| » ‖ HMAC_PEPPER_ID.
 */
import { createHmac } from "node:crypto";

import { deriveIdentifierHmacKey } from "@flaw/crypto";

import { decodeValidatedKey } from "../crypto/kek.ts";

export function hmacKey(pepperBase64: string, pepperId: string): Buffer {
  const decoded = decodeValidatedKey(pepperBase64);
  if (decoded === null) {
    throw new Error("refus de démarrer : hmac");
  }
  try {
    return Buffer.from(deriveIdentifierHmacKey(decoded, pepperId));
  } finally {
    decoded.fill(0);
  }
}

export function hmacHex(key: Buffer, value: string): string {
  return createHmac("sha256", key).update(value, "utf8").digest("hex");
}

export function subjectHmac(key: Buffer, identifier: string): string {
  return hmacHex(key, `subject|${identifier}`);
}

export function ipHmac(key: Buffer, ip: string): string {
  return hmacHex(key, `ip|${ip}`);
}

export function bucketHmac(key: Buffer, label: string): string {
  return hmacHex(key, `bucket|${label}`);
}

export function tempHmac(key: Buffer, userId: string): string {
  return hmacHex(key, `temp-password|${userId}`);
}
