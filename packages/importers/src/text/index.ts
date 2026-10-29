import { suggestMode, type Block, type ImportResult } from "../blocks.ts";
import { fail } from "../errors.ts";
import { LIMITS } from "../limits.ts";

/**
 * Décodage strict (SEC-IMP-08) : BOM retiré, UTF-16 par BOM, UTF-8 fatal, sinon
 * Windows-1252 avec avertissement ; octets nuls refusés ; NFC ; jamais interprété.
 */
export function decodeText(bytes: Uint8Array): { text: string; windows1252: boolean } {
  if (bytes.length > LIMITS.textFileBytes) fail("too_large");
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder("utf-16le", { fatal: true }).decode(bytes.subarray(2)).normalize("NFC"), windows1252: false };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder("utf-16be", { fatal: true }).decode(bytes.subarray(2)).normalize("NFC"), windows1252: false };
  }
  if (bytes.includes(0)) fail("null_bytes");
  const body = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(body).normalize("NFC"), windows1252: false };
  } catch {
    try {
      return { text: new TextDecoder("windows-1252").decode(body).normalize("NFC"), windows1252: true };
    } catch {
      return fail("encoding");
    }
  }
}

export function importText(bytes: Uint8Array, fileName: string): ImportResult {
  const { text, windows1252 } = decodeText(bytes);
  const blocks: Block[] = text
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .map((line): Block => (/^\s*(\*\s*){3}$/u.test(line) ? { kind: "break" } : { kind: "paragraph", runs: [{ text: line }] }));
  return {
    title: fileName.replace(/\.txt$/iu, "").trim() || "Sans titre",
    suggestedMode: suggestMode(blocks, false),
    blocks,
    report: { simplified: false, invisible: 0, externalLinks: 0, footnotes: 0, windows1252 },
  };
}
