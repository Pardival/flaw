/** Politique affichée et contrôlée avant envoi. Le serveur reste la référence (15 min., 128 max.). */

export const PASSWORD_MIN_LENGTH = 15;
export const PASSWORD_MAX_LENGTH = 128;
export const IDENTIFIER_MAX_LENGTH = 320;

export function codePointLength(value: string): number {
  return Array.from(value.normalize("NFC")).length;
}

export function passwordAccepted(raw: string): boolean {
  const length = codePointLength(raw);
  return length >= PASSWORD_MIN_LENGTH && length <= PASSWORD_MAX_LENGTH;
}
