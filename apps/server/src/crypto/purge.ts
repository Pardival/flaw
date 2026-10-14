/**
 * Consigne chiffrée du résultat de purge_journaux() dans flaw.audit_events.
 *
 * PROVISOIRE — BLOCKER de schéma :
 * audit_events n'a pas de colonnes *_ct, *_nonce, key_id, enc_version
 * (T-005 : id, owner_id, event_type, result text, created_at).
 * L'enveloppe est sérialisée dans result. Pas de clair dans cette colonne.
 * purge_journaux() SQL retourne void : le clair est
 * {"fonction":"purge_journaux","id":"...","statut":"ok"} après succès
 * de l'appel injecté. Le propriétaire de la ligne est userId, fourni par
 * l'appelant : le paquet ne désigne pas le compte d'une purge globale.
 * Pas de transaction ici : si l'INSERT échoue, la purge a déjà eu lieu.
 */
import { Buffer } from "node:buffer";

import {
  CONTENT_TYPE,
  CryptoError,
  openContent,
  sealContent,
  unwrapDek,
  type DekLookup,
  type Sealed,
  type WrappedDek,
} from "@flaw/crypto";

export type SqlQuery = (sql: string, params: readonly unknown[]) => Promise<unknown>;

export type PurgeConsigne = {
  id: string;
  ownerId: string;
  eventType: "purge_journaux";
  result: string;
};

function newId(explicit: string | undefined): string {
  if (explicit !== undefined) {
    if (explicit.length === 0) {
      throw new CryptoError("invalid_binding");
    }
    return explicit;
  }
  return globalThis.crypto.randomUUID();
}

function clairPurge(id: string): Uint8Array {
  const json = JSON.stringify({ fonction: "purge_journaux", id, statut: "ok" });
  return Buffer.from(json, "utf8");
}

export function encodeEnvelope(sealed: Sealed): string {
  return JSON.stringify({
    enc_version: sealed.encVersion,
    key_id: sealed.keyId,
    nonce: Buffer.from(sealed.nonce).toString("base64"),
    ct: Buffer.from(sealed.ciphertext).toString("base64"),
  });
}

export function decodeEnvelope(encoded: string): Sealed {
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    throw new CryptoError("invalid_envelope");
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new CryptoError("invalid_envelope");
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.enc_version !== "number" ||
    typeof record.key_id !== "string" ||
    typeof record.nonce !== "string" ||
    typeof record.ct !== "string"
  ) {
    throw new CryptoError("invalid_envelope");
  }
  const nonce = Buffer.from(record.nonce, "base64");
  const ciphertext = Buffer.from(record.ct, "base64");
  if (nonce.toString("base64") !== record.nonce || ciphertext.toString("base64") !== record.ct) {
    throw new CryptoError("invalid_envelope");
  }
  return {
    encVersion: record.enc_version,
    keyId: record.key_id,
    nonce: Uint8Array.from(nonce),
    ciphertext: Uint8Array.from(ciphertext),
  };
}

export async function consignerResultatPurge(input: {
  query: SqlQuery;
  purge: () => Promise<void>;
  kek: Uint8Array;
  userId: string;
  keyId: string;
  wrapped: WrappedDek;
  id?: string;
}): Promise<PurgeConsigne> {
  const dek = unwrapDek(input.kek, input.userId, input.wrapped);
  const id = newId(input.id);
  await input.purge();
  const sealed = sealContent(
    dek,
    input.keyId,
    { textId: id, ownerId: input.userId, type: CONTENT_TYPE.audit },
    clairPurge(id),
  );
  const result = encodeEnvelope(sealed);
  await input.query(
    "INSERT INTO flaw.audit_events (id, owner_id, event_type, result) VALUES ($1, $2, $3, $4)",
    [id, input.userId, "purge_journaux", result],
  );
  return { id, ownerId: input.userId, eventType: "purge_journaux", result };
}

export function lireResultatPurge(input: {
  id: string;
  ownerId: string;
  result: string;
  resolveDek: DekLookup;
}): Uint8Array {
  return openContent(
    { textId: input.id, ownerId: input.ownerId, type: CONTENT_TYPE.audit },
    decodeEnvelope(input.result),
    input.resolveDek,
  );
}
