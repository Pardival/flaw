/**
 * Lecture de flaw_kek. Le validateur est celui de T-002
 * (readSecretFile, kind « key ») : aucune règle n'est réécrite.
 * Le décodage base64 suit une validation déjà réussie.
 */
import { Buffer } from "node:buffer";

import { KEY_LENGTH } from "@flaw/crypto";

import { readSecretFile } from "../platform/healthz.ts";

export type KekLoad =
  | { ok: true; kek: Uint8Array }
  | { ok: false; message: string };

export function decodeValidatedKey(encoded: string): Uint8Array | null {
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length !== KEY_LENGTH || decoded.toString("base64") !== encoded) {
    return null;
  }
  return Uint8Array.from(decoded);
}

export function loadKekFile(filePath: string): KekLoad {
  const read = readSecretFile(filePath, "key");
  if (!read.ok) {
    return read;
  }
  const kek = decodeValidatedKey(read.value);
  if (kek === null) {
    return { ok: false, message: "refus de démarrer : kek" };
  }
  return { ok: true, kek };
}
