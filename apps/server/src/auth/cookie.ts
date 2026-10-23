/**
 * Cookie __Secure-flaw.session_token : HttpOnly, Secure, SameSite=Lax, Path=/, sans Domain.
 * Cookie __Secure-flaw.device : secret aléatoire, HttpOnly, Secure, SameSite=Strict, 90 jours.
 * Seul le hachage SHA-256 du secret d'appareil est conservé.
 */
import { createHash, randomBytes } from "node:crypto";

export const SESSION_COOKIE = "__Secure-flaw.session_token";
export const DEVICE_COOKIE = "__Secure-flaw.device";
export const DEVICE_MAX_AGE = 90 * 24 * 60 * 60;

export function newSessionToken(): { token: string; hash: Buffer } {
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token, "utf8").digest();
  return { token, hash };
}

export function hashSessionToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export function newDeviceToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashDeviceToken(token) };
}

export function hashDeviceToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function serializeDeviceCookie(token: string): string {
  return [
    `${DEVICE_COOKIE}=${token}`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${DEVICE_MAX_AGE}`,
  ].join("; ");
}

export function serializeSessionCookie(token: string, maxAgeSeconds: number | null): string {
  const parts = [`${SESSION_COOKIE}=${token}`, "HttpOnly", "Secure", "SameSite=Lax", "Path=/"];
  if (maxAgeSeconds !== null) {
    parts.push(`Max-Age=${maxAgeSeconds}`);
  }
  return parts.join("; ");
}

export function clearSessionCookie(): string {
  return serializeSessionCookie("", 0);
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined || header.length === 0) {
    return undefined;
  }
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    if (trimmed.slice(0, eq) !== name) {
      continue;
    }
    const value = trimmed.slice(eq + 1);
    if (value.length === 0 || value.length > 128) {
      return undefined;
    }
    return value;
  }
  return undefined;
}

export function readBearer(header: string | undefined): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  const match = /^Bearer ([A-Za-z0-9_-]{20,128})$/.exec(header);
  return match?.[1];
}
