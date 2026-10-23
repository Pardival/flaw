/**
 * Lecture de flaw_kek. Le validateur est celui de T-002
 * (readSecretFile, kind « key ») : aucune règle n'est réécrite.
 * Le décodage base64 suit une validation déjà réussie.
 */
import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";

import { KEY_LENGTH } from "@flaw/crypto";

import { readSecretFile } from "../platform/healthz.ts";

export type KekLoad =
  | { ok: true; kek: Uint8Array }
  | { ok: false; message: string };

export function decodeValidatedKey(encoded: string): Uint8Array | null {
  const decoded = Buffer.from(encoded, "base64");
  try {
    if (decoded.length !== KEY_LENGTH || decoded.toString("base64") !== encoded) {
      return null;
    }
    return Uint8Array.from(decoded);
  } finally {
    decoded.fill(0);
  }
}

/** Compare les octets déjà décodés, sans les effacer. */
export function sameKeyBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

function sameKey(left: Uint8Array | null, right: Uint8Array | null): boolean {
  try {
    if (left === null || right === null || left.length !== right.length) {
      return false;
    }
    return timingSafeEqual(left, right);
  } finally {
    left?.fill(0);
    right?.fill(0);
  }
}

/** Refus de démarrer si un poivre égale la KEK, ou si les deux poivres sont égaux. */
export function peppersMatchKek(kek: string, hmacPepper: string, recoveryPepper: string): boolean {
  return sameKey(decodeValidatedKey(kek), decodeValidatedKey(hmacPepper))
    || sameKey(decodeValidatedKey(kek), decodeValidatedKey(recoveryPepper))
    || sameKey(decodeValidatedKey(hmacPepper), decodeValidatedKey(recoveryPepper));
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
