/**
 * Rotation de KEK (Q-011, Q-015). Ré-enveloppe toutes les DEK, met à jour
 * user_keys.key_id, vérifie le déballage, puis marque l'ancienne KEK `retired`.
 * Aucun fichier n'est détruit : l'ancienne KEK reste disponible pour déchiffrer
 * jusqu'à la fin de la rétention. La destruction planifiée est T-042.
 * Les codes de secours (HMAC du poivre) ne sont pas touchés.
 * Une DEK `revoked` est ré-enveloppée et reste non résoluble.
 */
import { timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import { unwrapDek, wrapDek, type KeyStatus } from "@flaw/crypto";

type KeyRow = {
  id: string;
  owner_id: string;
  wrapped_ct: Buffer;
  wrapped_nonce: Buffer;
  key_id: string;
  enc_version: number;
  status: string;
};

export async function rotateAllDeks(
  pool: Pool,
  oldKek: Uint8Array,
  oldId: string,
  newKek: Uint8Array,
  newId: string,
): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const owners = await rewrap(client, oldKek, oldId, newKek, newId);
    await client.query("COMMIT");
    return owners;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function rewrap(
  client: PoolClient,
  oldKek: Uint8Array,
  oldId: string,
  newKek: Uint8Array,
  newId: string,
): Promise<string[]> {
  await client.query("LOCK TABLE flaw.user_keys IN SHARE ROW EXCLUSIVE MODE");
  await client.query("LOCK TABLE flaw.keks IN SHARE ROW EXCLUSIVE MODE");
  const taken = await client.query("SELECT id FROM flaw.keks WHERE id = $1", [newId]);
  if ((taken.rowCount ?? 0) > 0) {
    throw new Error("kek inattendue");
  }
  const rows = await client.query<KeyRow>(
    `SELECT id, owner_id, wrapped_ct, wrapped_nonce, key_id, enc_version, status
     FROM flaw.user_keys`,
  );
  const owners = new Set<string>();
  for (const row of rows.rows) {
    if (row.key_id !== oldId) {
      throw new Error("kek inattendue");
    }
    const wrapped = {
      wrappedCt: new Uint8Array(row.wrapped_ct),
      wrappedNonce: new Uint8Array(row.wrapped_nonce),
      keyId: row.key_id,
      encVersion: row.enc_version,
      status: row.status as KeyStatus,
    };
    const dek = unwrapDek(oldKek, row.owner_id, wrapped);
    const next = wrapDek(newKek, newId, row.owner_id, dek);
    const check = unwrapDek(newKek, row.owner_id, next);
    try {
      if (check.length !== dek.length || !timingSafeEqual(check, dek)) {
        throw new Error("verification kek");
      }
    } finally {
      dek.fill(0);
      check.fill(0);
    }
    const updated = await client.query(
      `UPDATE flaw.user_keys
       SET wrapped_ct = $2, wrapped_nonce = $3, key_id = $4, enc_version = $5
       WHERE id = $1 AND key_id = $6`,
      [row.id, Buffer.from(next.wrappedCt), Buffer.from(next.wrappedNonce), newId, next.encVersion, oldId],
    );
    if ((updated.rowCount ?? 0) !== 1) {
      throw new Error("verification kek");
    }
    owners.add(row.owner_id);
  }
  const left = await client.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM flaw.user_keys WHERE key_id = $1",
    [oldId],
  );
  if ((left.rows[0]?.n ?? 1) !== 0) {
    throw new Error("verification kek");
  }
  await client.query(
    `INSERT INTO flaw.keks (id, status) VALUES ($1, 'retired')
     ON CONFLICT (id) DO UPDATE SET status = 'retired'`,
    [oldId],
  );
  await client.query("INSERT INTO flaw.keks (id, status) VALUES ($1, 'active')", [newId]);
  return [...owners];
}
