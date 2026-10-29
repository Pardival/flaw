/**
 * Persistance Yjs chiffrée (A-008, A-013) : journal des mises à jour (document_updates),
 * compaction en une seule mise à jour fusionnée, état ProseMirror (document_states)
 * et projection (titre, extrait, plan) recalculés à chaque compaction.
 */
import { randomBytes } from "node:crypto";

import { COLUMN, dekResolvable, openContent, sealContent, unwrapDek, type ContentColumn, type KeyStatus } from "@flaw/crypto";
import type { Pool } from "pg";
import * as Y from "yjs";

import { can, validActor, type AccessActor } from "../access/can.ts";
import { withActor } from "../access/scope.ts";
import type { Sql } from "../access/sql.ts";
import { findActiveUserKey, findUserKey, type UserKeyRow } from "../auth/store.ts";
import { describeDocument, isProjection, readDocument, replaceTitle } from "../documents/prose.ts";
import { CONTENT_FRAGMENT } from "../../../../packages/sync/src/index.ts";
import { fragmentToProseMirrorJson } from "./yjs-prosemirror.ts";

export function uuidV7(): string {
  const bytes = randomBytes(16);
  const ms = BigInt(Date.now());
  for (let index = 0; index < 6; index += 1) {
    bytes[index] = Number((ms >> BigInt(40 - index * 8)) & 0xffn);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
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

/** Trousseau de DEK d'une transaction, effacé par `release`. */
export type Keyring = {
  get: (keyId: string) => Promise<Uint8Array | undefined>;
  active: () => Promise<{ id: string; dek: Uint8Array } | undefined>;
  release: () => void;
};

export function keyring(sql: Sql, kek: Uint8Array, userId: string): Keyring {
  const keys = new Map<string, Uint8Array>();
  const get = async (keyId: string): Promise<Uint8Array | undefined> => {
    const cached = keys.get(keyId);
    if (cached !== undefined) {
      return cached;
    }
    const found = await findUserKey(sql, userId, keyId);
    const dek = found === null ? undefined : openDek(kek, userId, found);
    if (dek !== undefined) {
      keys.set(keyId, dek);
    }
    return dek;
  };
  return {
    get,
    active: async () => {
      const row = await findActiveUserKey(sql, userId);
      if (row === null) {
        return undefined;
      }
      const dek = await get(row.id);
      return dek === undefined ? undefined : { id: row.id, dek };
    },
    release: () => {
      for (const dek of keys.values()) {
        dek.fill(0);
      }
      keys.clear();
    },
  };
}

export function seal(
  dek: { id: string; dek: Uint8Array },
  ownerId: string,
  rowId: string,
  column: ContentColumn,
  plain: Uint8Array,
): { ct: Buffer; nonce: Buffer; encVersion: number } {
  const sealed = sealContent(dek.dek, dek.id, { ownerId, rowId, column }, plain);
  return { ct: Buffer.from(sealed.ciphertext), nonce: Buffer.from(sealed.nonce), encVersion: sealed.encVersion };
}

export async function openSealed(
  keys: Keyring,
  ownerId: string,
  rowId: string,
  column: ContentColumn,
  row: { ct: Buffer; nonce: Buffer; keyId: string; encVersion: number },
): Promise<Uint8Array | undefined> {
  const dek = await keys.get(row.keyId);
  if (dek === undefined) {
    return undefined;
  }
  try {
    return openContent(
      { ownerId, rowId, column },
      { ciphertext: new Uint8Array(row.ct), nonce: new Uint8Array(row.nonce), keyId: row.keyId, encVersion: row.encVersion },
      () => dek,
    );
  } catch {
    return undefined;
  }
}

type UpdateRow = { id: string; update_ct: Buffer; update_nonce: Buffer; key_id: string; enc_version: number };

/** Journal déchiffré, dans l'ordre d'écriture. `undefined` si une ligne est illisible. */
export async function readJournal(
  sql: Sql,
  keys: Keyring,
  ownerId: string,
  documentId: string,
): Promise<{ ids: string[]; updates: Uint8Array[] } | undefined> {
  const result = await sql.query<UpdateRow>(
    `SELECT id, update_ct, update_nonce, key_id, enc_version
     FROM flaw.document_updates
     WHERE document_id = $1 AND owner_id = $2
     ORDER BY created_at, id`,
    [documentId, ownerId],
  );
  const ids: string[] = [];
  const updates: Uint8Array[] = [];
  for (const row of result.rows) {
    const plain = await openSealed(keys, ownerId, row.id, COLUMN.updateCt, {
      ct: row.update_ct,
      nonce: row.update_nonce,
      keyId: row.key_id,
      encVersion: row.enc_version,
    });
    if (plain === undefined) {
      return undefined;
    }
    ids.push(row.id);
    updates.push(plain);
  }
  return { ids, updates };
}

export async function appendJournal(sql: Sql, keys: Keyring, ownerId: string, documentId: string, update: Uint8Array): Promise<boolean> {
  const active = await keys.active();
  if (active === undefined) {
    return false;
  }
  const id = uuidV7();
  const sealed = seal(active, ownerId, id, COLUMN.updateCt, update);
  await sql.query(
    `INSERT INTO flaw.document_updates (id, document_id, owner_id, update_ct, update_nonce, key_id, enc_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, documentId, ownerId, sealed.ct, sealed.nonce, active.id, sealed.encVersion],
  );
  return true;
}

/** Contrôle d'accès commun WSS et repli HTTP : propriétaire du texte, non supprimé définitivement. */
export async function maySync(sql: Sql, actor: AccessActor, documentId: string): Promise<boolean> {
  if (!validActor(actor)) {
    return false;
  }
  const decision = await can(sql, actor, "sync", { type: "document", id: documentId });
  return decision.ok;
}

/** Charge le journal dans `doc`. Faux si le texte est inaccessible ou illisible. */
export async function loadInto(pool: Pool, actor: AccessActor, kek: Uint8Array, documentId: string, doc: Y.Doc): Promise<boolean> {
  return withActor(pool, actor.userId, async (sql) => {
    if (!(await maySync(sql, actor, documentId))) {
      return false;
    }
    const keys = keyring(sql, kek, actor.userId);
    try {
      const journal = await readJournal(sql, keys, actor.userId, documentId);
      if (journal === undefined) {
        return false;
      }
      if (journal.updates.length > 0) {
        Y.applyUpdate(doc, Y.mergeUpdates(journal.updates), LOAD_ORIGIN);
      }
      for (const update of journal.updates) {
        update.fill(0);
      }
      return true;
    } finally {
      keys.release();
    }
  });
}

/** Origine des mises à jour issues du stockage : jamais rejournalisées. */
export const LOAD_ORIGIN = { source: "local", skipStoreHooks: true, flaw: "storage" } as const;

export async function appendUpdate(pool: Pool, actor: AccessActor, kek: Uint8Array, documentId: string, update: Uint8Array): Promise<boolean> {
  return withActor(pool, actor.userId, async (sql) => {
    if (!(await maySync(sql, actor, documentId))) {
      return false;
    }
    const keys = keyring(sql, kek, actor.userId);
    try {
      return await appendJournal(sql, keys, actor.userId, documentId, update);
    } finally {
      keys.release();
    }
  });
}

type DocumentRow = {
  id: string;
  owner_id: string;
  projection_ct: Buffer;
  projection_nonce: Buffer;
  key_id: string;
  enc_version: number;
};

/**
 * Compaction : le journal lu est remplacé par l'état fusionné de `doc`, puis l'état
 * ProseMirror, la projection et le compteur sont recalculés. Le titre reste celui
 * de la projection (métadonnée REST), jamais celui du contenu.
 */
export async function compact(pool: Pool, actor: AccessActor, kek: Uint8Array, documentId: string, doc: Y.Doc): Promise<void> {
  await withActor(pool, actor.userId, async (sql) => {
    if (!(await maySync(sql, actor, documentId))) {
      return;
    }
    const keys = keyring(sql, kek, actor.userId);
    try {
      const listed = await sql.query<{ id: string }>(
        "SELECT id FROM flaw.document_updates WHERE document_id = $1 AND owner_id = $2",
        [documentId, actor.userId],
      );
      const merged = Y.encodeStateAsUpdate(doc);
      if (!(await appendJournal(sql, keys, actor.userId, documentId, merged))) {
        return;
      }
      const ids = listed.rows.map((row) => row.id);
      if (ids.length > 0) {
        await sql.query("DELETE FROM flaw.document_updates WHERE owner_id = $1 AND id = ANY($2::uuid[])", [actor.userId, ids]);
      }
      await project(sql, keys, actor.userId, documentId, doc);
    } finally {
      keys.release();
    }
  });
}

async function project(sql: Sql, keys: Keyring, ownerId: string, documentId: string, doc: Y.Doc): Promise<void> {
  const json = fragmentToProseMirrorJson(doc.getXmlFragment(CONTENT_FRAGMENT));
  if (json === undefined) {
    return;
  }
  const loaded = await sql.query<DocumentRow>(
    `SELECT id, owner_id, projection_ct, projection_nonce, key_id, enc_version
     FROM flaw.documents WHERE id = $1 AND owner_id = $2`,
    [documentId, ownerId],
  );
  const row = loaded.rows[0];
  const active = await keys.active();
  if (row === undefined || active === undefined) {
    return;
  }
  let title = "";
  let baseFontSizePt = 11;
  const plain = await openSealed(keys, ownerId, row.id, COLUMN.projectionCt, {
    ct: row.projection_ct,
    nonce: row.projection_nonce,
    keyId: row.key_id,
    encVersion: row.enc_version,
  });
  if (plain !== undefined) {
    try {
      const value = JSON.parse(Buffer.from(plain).toString("utf8")) as unknown;
      if (isProjection(value)) {
        title = value.title;
        baseFontSizePt = typeof value.baseFontSizePt === "number" ? value.baseFontSizePt : baseFontSizePt;
      }
    } catch {
      // Projection illisible : le titre repart vide plutôt que d'échouer la synchro.
    }
    plain.fill(0);
  }
  let described;
  try {
    described = describeDocument(replaceTitle(readDocument(json), title), baseFontSizePt);
  } catch {
    // Contenu hors schéma : rien n'est projeté (SEC-DATA-02), le journal garde les octets Yjs.
    return;
  }
  const projection = seal(
    active,
    ownerId,
    documentId,
    COLUMN.projectionCt,
    Buffer.from(
      JSON.stringify({
        title: described.title,
        excerpt: described.excerpt,
        outline: described.outline,
        baseFontSizePt: described.baseFontSizePt,
        schemaVersion: described.schemaVersion,
      }),
      "utf8",
    ),
  );
  const state = seal(active, ownerId, documentId, COLUMN.stateCt, Buffer.from(JSON.stringify(described.json), "utf8"));
  await sql.query(
    `UPDATE flaw.documents
     SET projection_ct = $3, projection_nonce = $4, key_id = $5, enc_version = $6,
         counter = $7, revision = revision + 1, updated_at = now()
     WHERE id = $1 AND owner_id = $2`,
    [documentId, ownerId, projection.ct, projection.nonce, active.id, projection.encVersion, described.wordCount],
  );
  await sql.query(
    `UPDATE flaw.document_states
     SET state_ct = $3, state_nonce = $4, key_id = $5, enc_version = $6, updated_at = now()
     WHERE document_id = $1 AND owner_id = $2`,
    [documentId, ownerId, state.ct, state.nonce, active.id, state.encVersion],
  );
}
