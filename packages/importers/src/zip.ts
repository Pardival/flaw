import { Inflate } from "fflate";

import { fail } from "./errors.ts";
import { LIMITS } from "./limits.ts";

/**
 * Lecteur ZIP défensif (SEC-IMP-04) : répertoire central lu d'abord, chemins et
 * doublons contrôlés, en-tête local comparé, chevauchements refusés, stored/deflate
 * seulement, octets réellement produits comptés (ratio, partie, total).
 */
export type ZipEntry = { name: string; method: number; compressed: number; size: number; offset: number; dataStart: number };

const u16 = (b: Uint8Array, o: number) => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
const u32 = (b: Uint8Array, o: number) => (((b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16)) >>> 0) + (b[o + 3] ?? 0) * 0x1000000;

function decodeName(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("path");
  }
}

function checkPath(name: string): void {
  if (name.length === 0 || name.length > LIMITS.zipPathLength) fail("path");
  if (name.startsWith("/") || /^[A-Za-z]:/u.test(name) || name.includes("\\")) fail("path");
  for (const char of name) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) fail("path");
  }
  const parts = name.split("/");
  if (parts.some((part) => part === "..")) fail("path");
  if (parts.length > LIMITS.zipPathDepth) fail("path");
}

export function readDirectory(bytes: Uint8Array): Map<string, ZipEntry> {
  // Fin du répertoire central : cherchée à rebours (commentaire ≤ 64 Kio).
  let eocd = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 22 - 65_535); index -= 1) {
    if (u32(bytes, index) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) fail("zip");
  const count = u16(bytes, eocd + 10);
  const size = u32(bytes, eocd + 12);
  const start = u32(bytes, eocd + 16);
  if (count === 0xffff || start === 0xffffffff) fail("zip"); // ZIP64 : non accepté.
  if (count > LIMITS.zipEntries) fail("entries");
  if (start + size > eocd) fail("zip");
  const entries = new Map<string, ZipEntry>();
  const lower = new Set<string>();
  const ranges: Array<[number, number]> = [];
  let cursor = start;
  for (let index = 0; index < count; index += 1) {
    if (u32(bytes, cursor) !== 0x02014b50) fail("zip");
    const flags = u16(bytes, cursor + 8);
    const method = u16(bytes, cursor + 10);
    const compressed = u32(bytes, cursor + 20);
    const uncompressed = u32(bytes, cursor + 24);
    const nameLength = u16(bytes, cursor + 28);
    const extraLength = u16(bytes, cursor + 30);
    const commentLength = u16(bytes, cursor + 32);
    const offset = u32(bytes, cursor + 42);
    const name = decodeName(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;
    if (flags & 0x1) fail("zip"); // chiffré
    if (method !== 0 && method !== 8) fail("zip");
    checkPath(name);
    const key = name.toLowerCase();
    if (lower.has(key)) fail("dup");
    lower.add(key);
    // En-tête local : doit confirmer le répertoire central.
    if (u32(bytes, offset) !== 0x04034b50) fail("zip");
    const localMethod = u16(bytes, offset + 8);
    const localNameLength = u16(bytes, offset + 26);
    const localExtra = u16(bytes, offset + 28);
    const localName = decodeName(bytes.subarray(offset + 30, offset + 30 + localNameLength));
    if (localMethod !== method || localName !== name) fail("zip");
    const dataStart = offset + 30 + localNameLength + localExtra;
    const end = dataStart + compressed;
    if (end > start) fail("zip");
    for (const [from, to] of ranges) {
      if (offset < to && end > from) fail("overlap");
    }
    ranges.push([offset, end]);
    entries.set(name, { name, method, compressed, size: uncompressed, offset, dataStart });
  }
  return entries;
}

/** Décompresse une entrée en comptant les octets produits ; arrêt immédiat au-delà des limites. */
export function extract(bytes: Uint8Array, entry: ZipEntry, budget: { used: number }): Uint8Array {
  const raw = bytes.subarray(entry.dataStart, entry.dataStart + entry.compressed);
  if (entry.method === 0) {
    if (raw.length !== entry.size) fail("zip_size");
    budget.used += raw.length;
    if (raw.length > LIMITS.zipPartBytes || budget.used > LIMITS.zipTotalBytes) fail("bomb");
    return raw;
  }
  const chunks: Uint8Array[] = [];
  let produced = 0;
  const inflater = new Inflate((chunk) => {
    produced += chunk.length;
    budget.used += chunk.length;
    if (produced > LIMITS.zipPartBytes || budget.used > LIMITS.zipTotalBytes || produced > Math.max(1, raw.length) * LIMITS.zipRatio) {
      fail("bomb");
    }
    chunks.push(chunk);
  });
  const step = 64 * 1024;
  for (let index = 0; index < raw.length; index += step) {
    inflater.push(raw.subarray(index, index + step), index + step >= raw.length);
  }
  if (produced !== entry.size) fail("zip_size");
  const out = new Uint8Array(produced);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
