/**
 * Journal chiffré du repli HTTP. Chaque mise à jour est scellée (SEC-DATA-05)
 * et rejouée une seule fois. Le vecteur d'état reste vide tant que Yjs
 * n'applique pas le journal : le client renvoie, le serveur déduplique.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";

import { COLUMN, dekResolvable, openContent, sealContent, unwrapDek, type KeyStatus } from "@flaw/crypto";
import { SCHEMA_VERSION } from "@flaw/schema/src/index.ts";
import type { Pool } from "pg";

import { can, validActor, type AccessActor } from "../access/can.ts";
import { withActor } from "../access/scope.ts";
import type { Sql } from "../access/sql.ts";
import { findActiveUserKey, findUserKey, type UserKeyRow } from "../auth/store.ts";
import { clientTooOld, decodeSyncRequest, encodeSyncReply, payloadTooLarge } from "../../../../packages/sync/src/index.ts";

export type SyncFailure = 404 | 413 | 422 | 426 | 500;

export type SyncOutcome = { ok: true; body: Buffer } | { ok: false; status: SyncFailure };

type ProjectionRow = {
  id: string;
  owner_id: string;
  projection_ct: Buffer;
  projection_nonce: Buffer;
  key_id: string;
  enc_version: number;
};

type UpdateRow = {
  id: string;
  update_ct: Buffer;
  update_nonce: Buffer;
  key_id: string;
  enc_version: number;
};

function forget(bytes: Uint8Array | undefined): void {
  bytes?.fill(0);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

function uuidV7(): string {
  const bytes = randomBytes(16);
  const ms = BigInt(Date.now());
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);
  const sixth = bytes[6] ?? 0;
  const eighth = bytes[8] ?? 0;
  bytes[6] = (sixth & 0x0f) | 0x70;
  bytes[8] = (eighth & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function openDek(kek: Uint8Array, userId: string, row: UserKeyRow): Uint8Array | undefined {
  if (!dekResolvable(row.status as KeyStatus)) {
    return undefined;
  }
  try {
    return unwrapDek(kek, userId, {
      wrappedCt: new Uint8Array(row.wrapped_ct),
      wrappedNonce: new Uint8Array(row.wrapped_nonce),
      keyId: row.key_id,
      encVersion: row.enc_version,
      status: row.status as KeyStatus,
    });
  } catch {
    return undefined;
  }
}

function schemaVersionOf(value: unknown): number | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const version = (value as { schemaVersion?: unknown }).schemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return undefined;
  }
  return version;
}

function emptyReply(): Buffer {
  return Buffer.from(encodeSyncReply(new Uint8Array(), new Uint8Array()));
}

export async function syncDocumentHttp(
  pool: Pool,
  actor: AccessActor,
  kek: Uint8Array | undefined,
  documentId: string,
  raw: Uint8Array | undefined,
  clientSchema: number | undefined,
  limit: number,
): Promise<SyncOutcome> {
  if (!validActor(actor) || kek === undefined) {
    return { ok: false, status: kek === undefined ? 500 : 404 };
  }
  return withActor(pool, actor.userId, async (sql) => {
    const decision = await can(sql, actor, "sync", { type: "document", id: documentId });
    if (!decision.ok) {
      return { ok: false, status: 404 };
    }
    const loaded = await sql.query<ProjectionRow>(
      `SELECT id, owner_id, projection_ct, projection_nonce, key_id, enc_version
       FROM flaw.documents
       WHERE id = $1 AND owner_id = $2`,
      [documentId, actor.userId],
    );
    const row = loaded.rows[0];
    if (row === undefined) {
      return { ok: false, status: 404 };
    }
    const keys = new Map<string, Uint8Array>();
    const remember = async (keyId: string): Promise<Uint8Array | undefined> => {
      const cached = keys.get(keyId);
      if (cached !== undefined) {
        return cached;
      }
      const found = await findUserKey(sql, actor.userId, keyId);
      const dek = found === null ? undefined : openDek(kek, actor.userId, found);
      if (dek !== undefined) {
        keys.set(keyId, dek);
      }
      return dek;
    };
    try {
      const dek = await remember(row.key_id);
      let schema = SCHEMA_VERSION;
      let readable = false;
      if (dek !== undefined) {
        try {
          const plain = openContent(
            { ownerId: row.owner_id, rowId: row.id, column: COLUMN.projectionCt },
            {
              ciphertext: new Uint8Array(row.projection_ct),
              nonce: new Uint8Array(row.projection_nonce),
              keyId: row.key_id,
              encVersion: row.enc_version,
            },
            () => dek,
          );
          const parsed = schemaVersionOf(JSON.parse(Buffer.from(plain).toString("utf8")) as unknown);
          plain.fill(0);
          if (parsed !== undefined) {
            schema = parsed;
            readable = true;
          }
        } catch {
          readable = false;
        }
      }
      if (clientTooOld(clientSchema, schema)) {
        return { ok: false, status: 426 };
      }
      // Projection ou DEK illisible : aucun journal. Un sondage sans mise à jour
      // reste 200 (fixture anti-IDOR), une écriture est refusée.
      if (raw === undefined) {
        return readable ? { ok: false, status: 422 } : { ok: true, body: emptyReply() };
      }
      if (payloadTooLarge(raw.byteLength, limit)) {
        return { ok: false, status: 413 };
      }
      const message = decodeSyncRequest(raw);
      if (message === undefined) {
        return { ok: false, status: 422 };
      }
      if (message.update.length === 0) {
        return { ok: true, body: emptyReply() };
      }
      if (!readable) {
        return { ok: false, status: 500 };
      }
      const active = await findActiveUserKey(sql, actor.userId);
      const activeDek = active === null ? undefined : await remember(active.id);
      if (active === null || activeDek === undefined) {
        return { ok: false, status: 500 };
      }
      const stored = await listUpdates(sql, actor.userId, documentId, remember);
      if (stored === undefined) {
        return { ok: false, status: 500 };
      }
      const known = stored.some((item) => sameBytes(item, message.update));
      for (const item of stored) {
        item.fill(0);
      }
      if (!known) {
        const id = uuidV7();
        const sealed = sealContent(
          activeDek,
          active.id,
          { ownerId: actor.userId, rowId: id, column: COLUMN.updateCt },
          message.update,
        );
        await sql.query(
          `INSERT INTO flaw.document_updates
             (id, document_id, owner_id, update_ct, update_nonce, key_id, enc_version)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            id,
            documentId,
            actor.userId,
            Buffer.from(sealed.ciphertext),
            Buffer.from(sealed.nonce),
            active.id,
            sealed.encVersion,
          ],
        );
      }
      return { ok: true, body: emptyReply() };
    } finally {
      for (const dek of keys.values()) {
        forget(dek);
      }
    }
  });
}

async function listUpdates(
  sql: Sql,
  ownerId: string,
  documentId: string,
  remember: (keyId: string) => Promise<Uint8Array | undefined>,
): Promise<Uint8Array[] | undefined> {
  const result = await sql.query<UpdateRow>(
    `SELECT id, update_ct, update_nonce, key_id, enc_version
     FROM flaw.document_updates
     WHERE document_id = $1 AND owner_id = $2
     ORDER BY created_at, id`,
    [documentId, ownerId],
  );
  const updates: Uint8Array[] = [];
  for (const row of result.rows) {
    const dek = await remember(row.key_id);
    if (dek === undefined) {
      return undefined;
    }
    try {
      updates.push(
        openContent(
          { ownerId, rowId: row.id, column: COLUMN.updateCt },
          {
            ciphertext: new Uint8Array(row.update_ct),
            nonce: new Uint8Array(row.update_nonce),
            keyId: row.key_id,
            encVersion: row.enc_version,
          },
          () => dek,
        ),
      );
    } catch {
      return undefined;
    }
  }
  return updates;
}
