/**
 * Nettoyage commun (C2 étendu) : retire les contrôles de direction et caractères
 * invisibles après décodage, normalise en NFC. Jamais interprété comme du balisage.
 */
const INVISIBLE = new Set<number>([0x061c, 0x180e, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff]);

export function clean(text: string): string {
  let out = "";
  for (const char of text.normalize("NFC")) {
    const code = char.codePointAt(0) ?? 0;
    if (INVISIBLE.has(code) || (code >= 0xe0000 && code <= 0xe007f)) {
      continue;
    }
    // Contrôles C0/C1 sauf tabulation (devenue espace) et sauts de ligne.
    if (code === 0x09) {
      out += " ";
      continue;
    }
    if ((code < 0x20 && code !== 0x0a && code !== 0x0d) || (code >= 0x7f && code <= 0x9f)) {
      continue;
    }
    out += char;
  }
  return out;
}

export function hasBidi(text: string): boolean {
  return clean(text) !== text.normalize("NFC").replace(/\t/gu, " ");
}
