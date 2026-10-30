/**
 * Repli HTTP de la synchronisation (API-016), sans Yjs.
 * Le corps est un encodage lib0 : vecteur d'état, puis mise à jour.
 * La réponse est la mise à jour manquante, puis le vecteur d'état serveur.
 * La fusion CRDT et le calcul du vecteur d'état arrivent avec Yjs.
 */

const MAX_VARINT_BYTES = 9;

export type SyncRequest = {
  stateVector: Uint8Array;
  update: Uint8Array;
};

function writeVarUint(value: number, into: number[]): void {
  if (!Number.isInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new RangeError("varuint");
  }
  let rest = value;
  while (rest > 127) {
    into.push((rest & 127) | 128);
    rest = Math.floor(rest / 128);
  }
  into.push(rest & 127);
}

function readVarUint(bytes: Uint8Array, offset: number): { value: number; next: number } | undefined {
  let value = 0;
  let factor = 1;
  let pos = offset;
  for (let count = 0; count < MAX_VARINT_BYTES; count += 1) {
    if (pos >= bytes.length) {
      return undefined;
    }
    const byte = bytes[pos] ?? 0;
    pos += 1;
    value += (byte & 127) * factor;
    if (value > Number.MAX_SAFE_INTEGER) {
      return undefined;
    }
    if ((byte & 128) === 0) {
      return { value, next: pos };
    }
    factor *= 128;
  }
  return undefined;
}

function readBlock(bytes: Uint8Array, offset: number): { value: Uint8Array; next: number } | undefined {
  const length = readVarUint(bytes, offset);
  if (length === undefined) {
    return undefined;
  }
  const end = length.next + length.value;
  if (end > bytes.length) {
    return undefined;
  }
  return { value: bytes.subarray(length.next, end), next: end };
}

function writeBlock(bytes: Uint8Array, into: number[]): void {
  writeVarUint(bytes.length, into);
  for (const byte of bytes) {
    into.push(byte);
  }
}

/** Corps vide : le client n'a encore rien à envoyer. */
export function decodeSyncRequest(bytes: Uint8Array): SyncRequest | undefined {
  if (bytes.length === 0) {
    return { stateVector: new Uint8Array(), update: new Uint8Array() };
  }
  const stateVector = readBlock(bytes, 0);
  if (stateVector === undefined) {
    return undefined;
  }
  const update = readBlock(bytes, stateVector.next);
  if (update === undefined || update.next !== bytes.length) {
    return undefined;
  }
  return { stateVector: stateVector.value, update: update.value };
}

function encodePair(first: Uint8Array, second: Uint8Array): Uint8Array {
  const into: number[] = [];
  writeBlock(first, into);
  writeBlock(second, into);
  return Uint8Array.from(into);
}

/** Requête : vecteur d'état du client, puis mise à jour locale. */
export function encodeSyncRequest(stateVector: Uint8Array, update: Uint8Array): Uint8Array {
  return encodePair(stateVector, update);
}

/** Réponse : mises à jour manquantes, puis vecteur d'état serveur. */
export function encodeSyncReply(update: Uint8Array, stateVector: Uint8Array): Uint8Array {
  return encodePair(update, stateVector);
}

/** Entier décimal sans zéro de tête. Absent ou illisible : client trop ancien. */
export function parseSchemaHeader(value: string | undefined): number | undefined {
  if (value === undefined || !/^(0|[1-9][0-9]{0,8})$/u.test(value)) {
    return undefined;
  }
  return Number(value);
}

/** 426 : le client est plus ancien que le schéma du texte. Un client plus récent passe. */
export function clientTooOld(client: number | undefined, documentSchema: number): boolean {
  if (client === undefined || !Number.isInteger(documentSchema) || documentSchema < 1) {
    return true;
  }
  return client < documentSchema;
}

export function payloadTooLarge(byteLength: number, limit: number): boolean {
  return byteLength > limit;
}

/** Structure du Y.Doc d'un texte (A-008) : contenu ProseMirror et métadonnées. */
export const CONTENT_FRAGMENT = "content";
export const META_MAP = "meta";
/** Fichiers du texte (images, couvertures) : empreinte → octets. */
export const ASSETS_MAP = "assets";

/** WSS multiplexé (API-024). Le paramètre `schema` porte la version du client. */
export const SYNC_PATH = "/api/v1/sync";
export const SYNC_SCHEMA_PARAM = "schema";

/** Revalidation de la session des WebSocket ouverts (SEC-API-06). */
export const SYNC_REVALIDATE_MS = 30_000;

/** Fermeture : session absente, expirée ou révoquée. */
export const SYNC_CLOSE_UNAUTHORIZED = 4401;
