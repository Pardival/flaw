/**
 * Résumé d'appareil : navigateur et système seulement.
 * Aucune localisation (ni pays, ni ville, ni coordonnées).
 * La confiance (AC-098) est un secret aléatoire, jamais le User-Agent.
 */
import { createHash, randomBytes } from "node:crypto";

export type DeviceSummary = {
  browser: string;
  os: string;
};

export function summarizeDevice(userAgent: string | null | undefined): DeviceSummary {
  const ua = userAgent ?? "";
  let browser = "inconnu";
  if (ua.includes("Edg/")) {
    browser = "Edge";
  } else if (ua.includes("Firefox/")) {
    browser = "Firefox";
  } else if (ua.includes("Chrome/") || ua.includes("CriOS/")) {
    browser = "Chrome";
  } else if (ua.includes("Safari/")) {
    browser = "Safari";
  }
  let os = "inconnu";
  if (ua.includes("Android")) {
    os = "Android";
  } else if (ua.includes("iPhone") || ua.includes("iPad")) {
    os = "iOS";
  } else if (ua.includes("Windows")) {
    os = "Windows";
  } else if (ua.includes("Mac OS")) {
    os = "macOS";
  } else if (ua.includes("Linux")) {
    os = "Linux";
  }
  return { browser, os };
}

export function deviceLabel(device: DeviceSummary): string {
  return `${device.browser}/${device.os}`;
}

/** 32 octets aléatoires. Seul le hachage SHA-256 est conservé en base. */
export function issueDeviceSecret(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashDeviceSecret(token) };
}

export function hashDeviceSecret(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function deviceSecretMatches(
  stored: { value_hash: string; expires_at: Date } | null,
  userId: string,
  now: Date,
): boolean {
  return stored !== null && stored.value_hash === userId && now.getTime() < stored.expires_at.getTime();
}
