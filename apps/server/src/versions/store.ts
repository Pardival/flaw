/**
 * Historique des versions (F17, A-009, T-032). Une version = état Yjs complet, chiffré
 * (version_ct), libellé chiffré (label_ct), raison et compteur en clair.
 * Restaurer = nouvelle modification CRDT : le contenu courant est remplacé par celui
 * de la version, après une version « avant restauration ». Rien n'est écrasé.
 */
import { COLUMN } from "@flaw/crypto";
import type { Pool } from "pg";
import * as Y from "yjs";

import type { AccessActor } from "../access/can.ts";
import { withActor } from "../access/scope.ts";
import type { Sql } from "../access/sql.ts";
import { CONTENT_FRAGMENT, META_MAP } from "../../../../packages/sync/src/index.ts";
import { liveDocuments } from "../sync/journal.ts";
import { appendJournal, keyring, maySync, openSealed, readJournal, seal, uuidV7, type Keyring } from "../sync/persistence.ts";

export type VersionReason =
  | "auto"
  | "session_end"
  | "manual"
  | "before_restore"
  | "before_delete"
  | "before_merge"
  | "before_layout_change"
  | "import";

export type VersionView = { id: string; createdAt: string; reason: VersionReason; label: string | null; wordCount: number };

/** Une version automatique au plus toutes les 10 minutes par texte. */
const AUTO_EVERY_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function wordsOf(doc: Y.Doc): number {
  const text = doc.getXmlFragment(CONTENT_FRAGMENT).toString().replace(/<[^>]*>/gu, " ").trim();
  return text.length === 0 ? 0 : text.split(/\s+/u).length;
}

async function loadDoc(sql: Sql, keys: Keyring, ownerId: string, documentId: string): Promise<Y.Doc | undefined> {
  const journal = await readJournal(sql, keys, ownerId, documentId);
  if (journal === undefined) {
    return undefined;
  }
  const doc = new Y.Doc();
  for (const update of journal.updates) {
    Y.applyUpdate(doc, update);
  }
  return doc;
}

async function insertVersion(
  sql: Sql,
  keys: Keyring,
  ownerId: string,
  documentId: string,
  doc: Y.Doc,
  reason: VersionReason,
  label: string | null,
): Promise<VersionView | undefined> {
  const active = await keys.active();
  if (active === undefined) {
    return undefined;
  }
  const id = uuidV7();
  const content = seal(active, ownerId, id, COLUMN.versionCt, Y.encodeStateAsUpdate(doc));
  const labelSealed = label === null ? null : seal(active, ownerId, id, COLUMN.labelCt, Buffer.from(label, "utf8"));
  const words = wordsOf(doc);
  const result = await sql.query<{ created_at: Date }>(
    `INSERT INTO flaw.document_versions
       (id, document_id, owner_id, version_ct, version_nonce, key_id, enc_version, label_ct, label_nonce, reason, word_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING created_at`,
    [
      id,
      documentId,
      ownerId,
      content.ct,
      content.nonce,
      active.id,
      content.encVersion,
      labelSealed?.ct ?? null,
      labelSealed?.nonce ?? null,
      reason,
      words,
    ],
  );
  await prune(sql, ownerId, documentId);
  return { id, createdAt: (result.rows[0]?.created_at ?? new Date()).toISOString(), reason, label, wordCount: words };
}

/**
 * Rétention (AC-062) : toutes pendant 30 jours, puis une par jour pendant 3 mois ;
 * les versions nommées (manuelles avec libellé) sont gardées.
 */
async function prune(sql: Sql, ownerId: string, documentId: string): Promise<void> {
  await sql.query(
    `DELETE FROM flaw.document_versions v
     WHERE v.owner_id = $1 AND v.document_id = $2 AND v.label_ct IS NULL
       AND (
         v.created_at < now() - interval '120 days'
         OR (v.created_at < now() - interval '30 days' AND EXISTS (
           SELECT 1 FROM flaw.document_versions w
           WHERE w.owner_id = v.owner_id AND w.document_id = v.document_id
             AND w.created_at::date = v.created_at::date AND w.created_at > v.created_at))
       )`,
    [ownerId, documentId],
  );
}

/** Version automatique ou de fin de session, appelée par la synchronisation. */
export async function snapshot(
  pool: Pool,
  actor: AccessActor,
  kek: Uint8Array,
  documentId: string,
  doc: Y.Doc,
  reason: "auto" | "session_end",
): Promise<void> {
  await withActor(pool, actor.userId, async (sql) => {
    if (!(await maySync(sql, actor, documentId))) {
      return;
    }
    const last = await sql.query<{ created_at: Date; word_count: number }>(
      `SELECT created_at, word_count FROM flaw.document_versions
       WHERE owner_id = $1 AND document_id = $2 ORDER BY created_at DESC LIMIT 1`,
      [actor.userId, documentId],
    );
    const previous = last.rows[0];
    if (reason === "auto" && previous !== undefined && Date.now() - previous.created_at.getTime() < AUTO_EVERY_MS) {
      return;
    }
    if (doc.getXmlFragment(CONTENT_FRAGMENT).length === 0) {
      return;
    }
    const keys = keyring(sql, kek, actor.userId);
    try {
      await insertVersion(sql, keys, actor.userId, documentId, doc, reason, null);
    } finally {
      keys.release();
    }
  });
}

export async function listVersions(pool: Pool, actor: AccessActor, kek: Uint8Array, documentId: string): Promise<VersionView[] | undefined> {
  return withActor(pool, actor.userId, async (sql) => {
    if (!(await maySync(sql, actor, documentId))) {
      return undefined;
    }
    const keys = keyring(sql, kek, actor.userId);
    try {
      const rows = await sql.query<{
        id: string;
        created_at: Date;
        reason: VersionReason;
        word_count: number;
        label_ct: Buffer | null;
        label_nonce: Buffer | null;
        key_id: string;
        enc_version: number;
      }>(
        `SELECT id, created_at, reason, word_count, label_ct, label_nonce, key_id, enc_version
         FROM flaw.document_versions WHERE owner_id = $1 AND document_id = $2 ORDER BY created_at DESC LIMIT 500`,
        [actor.userId, documentId],
      );
      const out: VersionView[] = [];
      for (const row of rows.rows) {
        let label: string | null = null;
        if (row.label_ct !== null && row.label_nonce !== null) {
          const plain = await openSealed(keys, actor.userId, row.id, COLUMN.labelCt, {
            ct: row.label_ct,
            nonce: row.label_nonce,
            keyId: row.key_id,
            encVersion: row.enc_version,
          });
          label = plain === undefined ? null : Buffer.from(plain).toString("utf8");
        }
        out.push({ id: row.id, createdAt: row.created_at.toISOString(), reason: row.reason, label, wordCount: row.word_count });
      }
      return out;
    } finally {
      keys.release();
    }
  });
}

export async function createManualVersion(
  pool: Pool,
  actor: AccessActor,
  kek: Uint8Array,
  documentId: string,
  label: string | null,
): Promise<VersionView | undefined> {
  return withActor(pool, actor.userId, async (sql) => {
    if (!(await maySync(sql, actor, documentId))) {
      return undefined;
    }
    const keys = keyring(sql, kek, actor.userId);
    try {
      const doc = await loadDoc(sql, keys, actor.userId, documentId);
      return doc === undefined ? undefined : await insertVersion(sql, keys, actor.userId, documentId, doc, "manual", label);
    } finally {
      keys.release();
    }
  });
}

async function versionDoc(sql: Sql, keys: Keyring, ownerId: string, documentId: string, versionId: string): Promise<Y.Doc | undefined> {
  const found = await sql.query<{ id: string; version_ct: Buffer; version_nonce: Buffer; key_id: string; enc_version: number }>(
    `SELECT id, version_ct, version_nonce, key_id, enc_version FROM flaw.document_versions
     WHERE owner_id = $1 AND document_id = $2 AND id = $3`,
    [ownerId, documentId, versionId],
  );
  const row = found.rows[0];
  if (row === undefined) {
    return undefined;
  }
  const plain = await openSealed(keys, ownerId, row.id, COLUMN.versionCt, {
    ct: row.version_ct,
    nonce: row.version_nonce,
    keyId: row.key_id,
    encVersion: row.enc_version,
  });
  if (plain === undefined) {
    return undefined;
  }
  const doc = new Y.Doc();
  Y.applyUpdate(doc, plain);
  return doc;
}

/** Remplace le contenu de `target` par celui de `source` dans une transaction Yjs. */
export function replaceContent(target: Y.Doc, source: Y.Doc): void {
  const into = target.getXmlFragment(CONTENT_FRAGMENT);
  const from = source.getXmlFragment(CONTENT_FRAGMENT);
  target.transact(() => {
    into.delete(0, into.length);
    into.insert(
      0,
      from.toArray().map((child) => (child as Y.XmlElement | Y.XmlText).clone()),
    );
    const meta = target.getMap<unknown>(META_MAP);
    source.getMap<unknown>(META_MAP).forEach((value, key) => {
      meta.set(key, value);
    });
  });
}

/** Version texte d'aperçu (D-039), sans HTML. */
export async function previewVersion(pool: Pool, actor: AccessActor, kek: Uint8Array, documentId: string, versionId: string): Promise<string | undefined> {
  return withActor(pool, actor.userId, async (sql) => {
    if (!(await maySync(sql, actor, documentId))) {
      return undefined;
    }
    const keys = keyring(sql, kek, actor.userId);
    try {
      const doc = await versionDoc(sql, keys, actor.userId, documentId, versionId);
      if (doc === undefined) {
        return undefined;
      }
      const blocks: string[] = [];
      for (const child of doc.getXmlFragment(CONTENT_FRAGMENT).toArray()) {
        blocks.push(child.toString().replace(/<[^>]*>/gu, ""));
      }
      return blocks.join("\n");
    } finally {
      keys.release();
    }
  });
}

export async function restoreVersion(pool: Pool, actor: AccessActor, kek: Uint8Array, documentId: string, versionId: string): Promise<boolean> {
  return withActor(pool, actor.userId, async (sql) => {
    if (!(await maySync(sql, actor, documentId))) {
      return false;
    }
    const keys = keyring(sql, kek, actor.userId);
    try {
      const source = await versionDoc(sql, keys, actor.userId, documentId, versionId);
      const current = await loadDoc(sql, keys, actor.userId, documentId);
      if (source === undefined || current === undefined) {
        return false;
      }
      await insertVersion(sql, keys, actor.userId, documentId, current, "before_restore", null);
      const before = Y.encodeStateVector(current);
      replaceContent(current, source);
      const update = Y.encodeStateAsUpdate(current, before);
      if (!(await appendJournal(sql, keys, actor.userId, documentId, update))) {
        return false;
      }
      liveDocuments.get(documentId)?.(update);
      return true;
    } finally {
      keys.release();
    }
  });
}

export { DAY_MS };
