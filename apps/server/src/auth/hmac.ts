/**
 * HMAC des identifiants. Clé HKDF-SHA-256 dérivée de hmac_pepper et HMAC_PEPPER_ID.
 */
import { createHmac, hkdfSync } from "node:crypto";

export function hmacKey(pepperBase64: string, pepperId: string): Buffer {
  const ikm = Buffer.from(pepperBase64, "base64");
  return Buffer.from(
    hkdfSync("sha256", ikm, Buffer.from(pepperId, "utf8"), Buffer.from("flaw/hmac/v1", "utf8"), 32),
  );
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
