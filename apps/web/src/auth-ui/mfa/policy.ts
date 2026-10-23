/**
 * Contrôles locaux avant envoi. Le serveur reste la référence.
 * TOTP : 6 chiffres (RFC 6238, HMAC-SHA-1, pas de 30 s), comme le module serveur.
 * Codes de secours : 16 caractères base32 RFC 4648, affichés XXXX-XXXX-XXXX-XXXX.
 * v1 : pas de code visuel. La clé part en clair et dans un lien otpauth://.
 */

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const RECOVERY_COMPACT = /^[A-Z2-7]{16}$/;
const SECRET_COMPACT = /^[A-Z2-7]{16,128}$/;

export const TOTP_ALGORITHM = "SHA1";
export const TOTP_DIGITS = "6";
export const TOTP_PERIOD = "30";
export const BACKUP_FILENAME = "codes-secours.txt";
export const RECOVERY_CODE_COUNT = 10;

export function formatTotp(raw: string): string | null {
  const digits = raw.normalize("NFC").replace(/\s/g, "");
  if (!/^\d{6}$/.test(digits)) {
    return null;
  }
  return digits;
}

export function formatRecoveryCode(raw: string): string | null {
  const compact = raw.normalize("NFC").replace(/[\s-]/g, "").toUpperCase();
  if (!RECOVERY_COMPACT.test(compact)) {
    return null;
  }
  return `${compact.slice(0, 4)}-${compact.slice(4, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}`;
}

export function formatSecret(raw: string): string | null {
  const compact = raw.normalize("NFC").replace(/[\s=-]/g, "").toUpperCase();
  if (!SECRET_COMPACT.test(compact) || [...compact].some((char) => !BASE32.includes(char))) {
    return null;
  }
  return compact;
}

export function groupSecret(secret: string): string {
  const parts: string[] = [];
  for (let index = 0; index < secret.length; index += 4) {
    parts.push(secret.slice(index, index + 4));
  }
  return parts.join(" ");
}

export function backupText(codes: readonly string[]): string {
  return `${codes.join("\n")}\n`;
}

function query(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

/** Lien otpauth://totp/ pour « Ouvrir l'application ». Null si la clé n'est pas du base32. */
export function otpauthUri(secret: string, accountLabel: string, issuer: string): string | null {
  const compact = formatSecret(secret);
  const label = accountLabel.normalize("NFC").trim();
  const brand = issuer.normalize("NFC").trim();
  if (compact === null || label.length === 0 || brand.length === 0) {
    return null;
  }
  const path = encodeURIComponent(`${brand}:${label}`);
  const params = query({
    secret: compact,
    issuer: brand,
    algorithm: TOTP_ALGORITHM,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD,
  });
  return `otpauth://totp/${path}?${params}`;
}
