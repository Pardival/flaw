/**
 * Repli HTTP de la synchronisation (API-016). Le journal chiffré est fusionné par Yjs :
 * la réponse porte ce qui manque au client (d'après son vecteur d'état) et le vecteur
 * d'état serveur. Une mise à jour déjà connue n'est pas rejournalisée (idempotence).
 */
import { COLUMN, openContent } from "@flaw/crypto";
import { SCHEMA_VERSION } from "@flaw/schema/src/index.ts";
import type { Pool } from "pg";
import * as Y from "yjs";

import { validActor, type AccessActor } from "../access/can.ts";
import { withActor } from "../access/scope.ts";
import { clientTooOld, decodeSyncRequest, encodeSyncReply, payloadTooLarge } from "../../../../packages/sync/src/index.ts";
import { appendJournal, keyring, maySync, readJournal } from "./persistence.ts";

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

/** Textes ouverts en WebSocket : une écriture HTTP leur est aussi appliquée. */
export const liveDocuments = new Map<string, (update: Uint8Array) => void>();

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
    if (!(await maySync(sql, actor, documentId))) {
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
    const keys = keyring(sql, kek, actor.userId);
    try {
      const dek = await keys.get(row.key_id);
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
      if (!readable) {
        return message.update.length === 0 ? { ok: true, body: emptyReply() } : { ok: false, status: 500 };
      }
      const journal = await readJournal(sql, keys, actor.userId, documentId);
      if (journal === undefined) {
        return { ok: false, status: 500 };
      }
      const doc = new Y.Doc({ gc: false });
      try {
        for (const update of journal.updates) {
          Y.applyUpdate(doc, update);
          update.fill(0);
        }
        if (message.update.length > 0) {
          const before = Y.snapshot(doc);
          try {
            Y.applyUpdate(doc, message.update);
          } catch {
            return { ok: false, status: 422 };
          }
          // Rien de nouveau (insertions ni suppressions) : la même opération rejouée n'a qu'un effet.
          const pending = doc.store.pendingStructs !== null || doc.store.pendingDs !== null;
          if (pending || !Y.equalSnapshots(before, Y.snapshot(doc))) {
            if (!(await appendJournal(sql, keys, actor.userId, documentId, message.update))) {
              return { ok: false, status: 500 };
            }
            liveDocuments.get(documentId)?.(message.update);
          }
        }
        let missing: Uint8Array;
        try {
          missing = Y.encodeStateAsUpdate(doc, message.stateVector.length > 0 ? message.stateVector : undefined);
        } catch {
          return { ok: false, status: 422 };
        }
        return { ok: true, body: Buffer.from(encodeSyncReply(missing, Y.encodeStateVector(doc))) };
      } finally {
        doc.destroy();
      }
    } finally {
      keys.release();
    }
  });
}
