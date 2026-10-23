/**
 * Persistance des textes. Titre, extrait et plan ne sortent que de la projection chiffrée.
 * Chaque requête porte l'owner_id de l'acteur. can() décide avant l'accès.
 */
import { COLUMN, dekResolvable, openContent, sealContent, unwrapDek, type ContentColumn, type KeyStatus } from "@flaw/crypto";
import type { Pool } from "pg";

import { can, validActor, type AccessActor } from "../access/can.ts";
import { withActor } from "../access/scope.ts";
import type { Sql } from "../access/sql.ts";
import { findActiveUserKey, type UserKeyRow } from "../auth/store.ts";
import {
  defaultsFor,
  describeDocument,
  documentMarkdown,
  documentPlainText,
  isProjection,
  readDocument,
  replaceTitle,
  titledDocument,
  type Projection,
} from "./prose.ts";
import type { ContentFormat, DocumentCreate, DocumentPatch } from "./schema.ts";

export type DocumentView = {
  id: string;
  title: string;
  mode: string;
  wordCount: number;
  updatedAt: string;
  deletedAt: string | null;
  excerpt: string;
  pageFormat: string;
  fontFamily: string;
  baseFontSizePt: number;
  schemaVersion: number;
  outline: Array<{ level: number; title: string }>;
  createdAt: string;
};

export type ListQuery = {
  limit: number;
  cursor: { at: Date; id: string } | undefined;
  trashed: boolean;
  updatedSince: Date | undefined;
};

type Row = {
  id: string;
  owner_id: string;
  mode: string;
  format: string;
  font: string;
  counter: number;
  revision: number;
  projection_ct: Buffer;
  projection_nonce: Buffer;
  key_id: string;
  enc_version: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  state_ct: Buffer | null;
  state_nonce: Buffer | null;
};

const SELECT_ROW = `SELECT d.id, d.owner_id, d.mode, d.format, d.font, d.counter, d.revision,
            d.projection_ct, d.projection_nonce, d.key_id, d.enc_version,
            d.created_at, d.updated_at, d.deleted_at, s.state_ct, s.state_nonce
     FROM flaw.documents d
     LEFT JOIN flaw.document_states s ON s.document_id = d.id AND s.owner_id = d.owner_id`;

const EMPTY_PROJECTION: Projection = {
  title: "",
  excerpt: "",
  outline: [],
  baseFontSizePt: 11,
  schemaVersion: 1,
};

export type StoreFailure = { ok: false; status: 404 | 409 | 500 };

function uniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  if ("code" in error && error.code === "23505") {
    return true;
  }
  if ("cause" in error) {
    return uniqueViolation(error.cause);
  }
  return false;
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

function sealJson(
  dek: Uint8Array,
  dekId: string,
  ownerId: string,
  rowId: string,
  column: ContentColumn,
  value: unknown,
): { ct: Buffer; nonce: Buffer; encVersion: number } {
  const sealed = sealContent(
    dek,
    dekId,
    { ownerId, rowId, column },
    Buffer.from(JSON.stringify(value), "utf8"),
  );
  return {
    ct: Buffer.from(sealed.ciphertext),
    nonce: Buffer.from(sealed.nonce),
    encVersion: sealed.encVersion,
  };
}

function openJson(
  dek: Uint8Array,
  dekId: string,
  ownerId: string,
  rowId: string,
  column: ContentColumn,
  ciphertext: Buffer,
  nonce: Buffer,
  encVersion: number,
): unknown {
  const plain = openContent(
    { ownerId, rowId, column },
    {
      ciphertext: new Uint8Array(ciphertext),
      nonce: new Uint8Array(nonce),
      keyId: dekId,
      encVersion,
    },
    (owner, key) => (owner === ownerId && key === dekId ? dek : undefined),
  );
  return JSON.parse(Buffer.from(plain).toString("utf8")) as unknown;
}

function forget(dek: Uint8Array | undefined): void {
  dek?.fill(0);
}

function projectionOf(row: Row, dek: Uint8Array | undefined): Projection {
  if (dek === undefined) {
    return EMPTY_PROJECTION;
  }
  try {
    const value = openJson(
      dek,
      row.key_id,
      row.owner_id,
      row.id,
      COLUMN.projectionCt,
      row.projection_ct,
      row.projection_nonce,
      row.enc_version,
    );
    if (!isProjection(value)) {
      return EMPTY_PROJECTION;
    }
    return {
      title: value.title,
      excerpt: typeof value.excerpt === "string" ? value.excerpt.slice(0, 200) : "",
      outline: value.outline.flatMap((item) => {
        if (item === null || typeof item !== "object") {
          return [];
        }
        const record = item as { level?: unknown; title?: unknown };
        if (typeof record.title !== "string") {
          return [];
        }
        const level = record.level === 2 || record.level === 3 ? record.level : 1;
        return [{ level, title: record.title }];
      }),
      baseFontSizePt: typeof value.baseFontSizePt === "number" ? value.baseFontSizePt : EMPTY_PROJECTION.baseFontSizePt,
      schemaVersion: typeof value.schemaVersion === "number" ? value.schemaVersion : EMPTY_PROJECTION.schemaVersion,
    };
  } catch {
    return EMPTY_PROJECTION;
  }
}

function viewOf(row: Row, projection: Projection): DocumentView {
  return {
    id: row.id,
    title: projection.title,
    mode: row.mode,
    wordCount: row.counter,
    updatedAt: row.updated_at.toISOString(),
    deletedAt: row.deleted_at === null ? null : row.deleted_at.toISOString(),
    excerpt: projection.excerpt,
    pageFormat: row.format,
    fontFamily: row.font,
    baseFontSizePt: projection.baseFontSizePt,
    schemaVersion: projection.schemaVersion,
    outline: projection.outline,
    createdAt: row.created_at.toISOString(),
  };
}

async function loadRow(sql: Sql, ownerId: string, documentId: string): Promise<Row | undefined> {
  const result = await sql.query<Row>(`${SELECT_ROW} WHERE d.id = $1 AND d.owner_id = $2`, [documentId, ownerId]);
  return result.rows[0];
}

async function activeDek(
  sql: Sql,
  kek: Uint8Array,
  actor: AccessActor,
): Promise<{ id: string; dek: Uint8Array } | undefined> {
  const key = await findActiveUserKey(sql, actor.userId);
  if (key === null) {
    return undefined;
  }
  const dek = openDek(kek, actor.userId, key);
  if (dek === undefined) {
    return undefined;
  }
  return { id: key.id, dek };
}

function stateOf(row: Row, dek: Uint8Array): ReturnType<typeof readDocument> | undefined {
  if (row.state_ct === null || row.state_nonce === null) {
    return undefined;
  }
  try {
    return readDocument(
      openJson(
        dek,
        row.key_id,
        row.owner_id,
        row.id,
        COLUMN.stateCt,
        row.state_ct,
        row.state_nonce,
        row.enc_version,
      ),
    );
  } catch {
    return undefined;
  }
}

async function allowed(sql: Sql, actor: AccessActor, action: "read" | "update" | "delete" | "sync", documentId: string): Promise<boolean> {
  const decision = await can(sql, actor, action, { type: "document", id: documentId });
  return decision.ok;
}

function summary(view: DocumentView): Pick<DocumentView, "id" | "title" | "mode" | "wordCount" | "updatedAt" | "deletedAt" | "excerpt"> {
  return {
    id: view.id,
    title: view.title,
    mode: view.mode,
    wordCount: view.wordCount,
    updatedAt: view.updatedAt,
    deletedAt: view.deletedAt,
    excerpt: view.excerpt,
  };
}

export async function listDocuments(
  pool: Pool,
  actor: AccessActor,
  kek: Uint8Array | undefined,
  query: ListQuery,
): Promise<{ items: ReturnType<typeof summary>[]; nextCursor: string | null } | StoreFailure> {
  if (!validActor(actor)) {
    return { ok: false, status: 404 };
  }
  return withActor(pool, actor.userId, async (sql) => {
    const decision = await can(sql, actor, "read", { type: "documents" });
    if (!decision.ok) {
      return { items: [], nextCursor: null };
    }
    const key = kek === undefined ? undefined : await activeDek(sql, kek, actor);
    const onlyTrashed = query.trashed;
    const includeDeleted = query.updatedSince !== undefined && !query.trashed;
    const params: unknown[] = [actor.userId];
    const filters = ["d.owner_id = $1"];
    if (onlyTrashed) {
      filters.push("d.deleted_at IS NOT NULL");
    } else if (!includeDeleted) {
      filters.push("d.deleted_at IS NULL");
    }
    if (query.updatedSince !== undefined) {
      params.push(query.updatedSince);
      filters.push(`d.updated_at > $${params.length}`);
    }
    if (query.cursor !== undefined) {
      params.push(query.cursor.at, query.cursor.id);
      const at = params.length - 1;
      const id = params.length;
      filters.push(`(d.updated_at < $${at} OR (d.updated_at = $${at} AND d.id < $${id}::uuid))`);
    }
    params.push(query.limit + 1);
    const result = await sql.query<Row>(
      `${SELECT_ROW}
       WHERE ${filters.join(" AND ")}
       ORDER BY d.updated_at DESC, d.id DESC
       LIMIT $${params.length}`,
      params,
    );
    try {
      const page = result.rows.slice(0, query.limit);
      const items = page.map((row) => summary(viewOf(row, projectionOf(row, key?.dek))));
      const last = page.at(-1);
      const nextCursor =
        result.rows.length > query.limit && last !== undefined ? encodeCursor(last.updated_at, last.id) : null;
      return { items, nextCursor };
    } finally {
      forget(key?.dek);
    }
  });
}

export function encodeCursor(updatedAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ u: updatedAt.toISOString(), i: id }), "utf8").toString("base64url");
}

export async function createDocument(
  pool: Pool,
  actor: AccessActor,
  kek: Uint8Array | undefined,
  input: DocumentCreate,
): Promise<{ ok: true; status: 200 | 201; document: DocumentView } | StoreFailure> {
  if (!validActor(actor) || kek === undefined) {
    return { ok: false, status: 500 };
  }
  try {
    return await withActor(pool, actor.userId, async (sql) => {
      const decision = await can(sql, actor, "read", { type: "documents" });
      if (!decision.ok) {
        return { ok: false, status: 404 };
      }
      const existing = await loadRow(sql, actor.userId, input.id);
      if (existing !== undefined) {
        const key = await activeDek(sql, kek, actor);
        try {
          return { ok: true as const, status: 200 as const, document: viewOf(existing, projectionOf(existing, key?.dek)) };
        } finally {
          forget(key?.dek);
        }
      }
      const key = await activeDek(sql, kek, actor);
      if (key === undefined) {
        return { ok: false, status: 500 };
      }
      try {
        const defaults = defaultsFor(input.mode);
        const pageFormat = input.pageFormat ?? defaults.pageFormat;
        const fontFamily = input.fontFamily ?? defaults.fontFamily;
        const described = describeDocument(titledDocument(input.mode, input.title ?? "Sans titre"), defaults.baseFontSizePt);
        const projection = sealJson(key.dek, key.id, actor.userId, input.id, COLUMN.projectionCt, {
          title: described.title,
          excerpt: described.excerpt,
          outline: described.outline,
          baseFontSizePt: described.baseFontSizePt,
          schemaVersion: described.schemaVersion,
        });
        const state = sealJson(key.dek, key.id, actor.userId, input.id, COLUMN.stateCt, described.json);
        await sql.query(
          `INSERT INTO flaw.documents (
             id, owner_id, mode, format, font, counter, revision,
             projection_ct, projection_nonce, key_id, enc_version
           ) VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8, $9, $10)`,
          [
            input.id,
            actor.userId,
            input.mode,
            pageFormat,
            fontFamily,
            described.wordCount,
            projection.ct,
            projection.nonce,
            key.id,
            projection.encVersion,
          ],
        );
        await sql.query(
          `INSERT INTO flaw.document_states (
             document_id, owner_id, state_ct, state_nonce, key_id, enc_version
           ) VALUES ($1, $2, $3, $4, $5, $6)`,
          [input.id, actor.userId, state.ct, state.nonce, key.id, state.encVersion],
        );
        const row = await loadRow(sql, actor.userId, input.id);
        if (row === undefined) {
          return { ok: false, status: 500 };
        }
        return { ok: true, status: 201, document: viewOf(row, projectionOf(row, key.dek)) };
      } finally {
        forget(key.dek);
      }
    });
  } catch (error) {
    if (!uniqueViolation(error)) {
      throw error;
    }
    const own = await withActor(pool, actor.userId, async (sql) => loadRow(sql, actor.userId, input.id));
    if (own === undefined) {
      return { ok: false, status: 409 };
    }
    return withActor(pool, actor.userId, async (sql) => {
      const key = await activeDek(sql, kek, actor);
      try {
        return { ok: true as const, status: 200 as const, document: viewOf(own, projectionOf(own, key?.dek)) };
      } finally {
        forget(key?.dek);
      }
    });
  }
}

export async function getDocument(
  pool: Pool,
  actor: AccessActor,
  kek: Uint8Array | undefined,
  documentId: string,
): Promise<{ ok: true; document: DocumentView; revision: number } | StoreFailure> {
  if (!validActor(actor)) {
    return { ok: false, status: 404 };
  }
  return withActor(pool, actor.userId, async (sql) => {
    if (!(await allowed(sql, actor, "read", documentId))) {
      return { ok: false, status: 404 };
    }
    const row = await loadRow(sql, actor.userId, documentId);
    if (row === undefined) {
      return { ok: false, status: 404 };
    }
    const key = kek === undefined ? undefined : await activeDek(sql, kek, actor);
    const dek = key !== undefined && key.id === row.key_id ? key.dek : undefined;
    try {
      return { ok: true, document: viewOf(row, projectionOf(row, dek ?? key?.dek)), revision: row.revision };
    } finally {
      forget(key?.dek);
    }
  });
}

async function writeRow(
  sql: Sql,
  actor: AccessActor,
  kek: Uint8Array,
  row: Row,
  next: { mode: string; format: string; font: string; described: ReturnType<typeof describeDocument>; deletedAt: Date | null | "keep" },
): Promise<DocumentView | undefined> {
  const key = await activeDek(sql, kek, actor);
  const dekId = key?.id ?? row.key_id;
  const dek = key?.dek;
  if (dek === undefined) {
    return undefined;
  }
  try {
    const projection = sealJson(dek, dekId, actor.userId, row.id, COLUMN.projectionCt, {
      title: next.described.title,
      excerpt: next.described.excerpt,
      outline: next.described.outline,
      baseFontSizePt: next.described.baseFontSizePt,
      schemaVersion: next.described.schemaVersion,
    });
    const state = sealJson(dek, dekId, actor.userId, row.id, COLUMN.stateCt, next.described.json);
    await sql.query(
      `UPDATE flaw.documents
       SET mode = $3, format = $4, font = $5, counter = $6, revision = revision + 1,
           projection_ct = $7, projection_nonce = $8, key_id = $9, enc_version = $10,
           updated_at = now(),
           deleted_at = CASE WHEN $11::boolean THEN deleted_at ELSE $12::timestamptz END
       WHERE id = $1 AND owner_id = $2`,
      [
        row.id,
        actor.userId,
        next.mode,
        next.format,
        next.font,
        next.described.wordCount,
        projection.ct,
        projection.nonce,
        dekId,
        projection.encVersion,
        next.deletedAt === "keep",
        next.deletedAt === "keep" ? null : next.deletedAt,
      ],
    );
    await sql.query(
      `INSERT INTO flaw.document_states (document_id, owner_id, state_ct, state_nonce, key_id, enc_version)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (document_id) DO UPDATE
       SET state_ct = EXCLUDED.state_ct, state_nonce = EXCLUDED.state_nonce,
           key_id = EXCLUDED.key_id, enc_version = EXCLUDED.enc_version, updated_at = now()`,
      [row.id, actor.userId, state.ct, state.nonce, dekId, state.encVersion],
    );
    const saved = await loadRow(sql, actor.userId, row.id);
    if (saved === undefined) {
      return undefined;
    }
    return viewOf(saved, projectionOf(saved, dek));
  } finally {
    forget(dek);
  }
}

export async function updateDocument(
  pool: Pool,
  actor: AccessActor,
  kek: Uint8Array | undefined,
  documentId: string,
  patch: DocumentPatch,
): Promise<{ ok: true; document: DocumentView } | StoreFailure> {
  if (!validActor(actor) || kek === undefined) {
    return { ok: false, status: kek === undefined ? 500 : 404 };
  }
  return withActor(pool, actor.userId, async (sql) => {
    if (!(await allowed(sql, actor, "update", documentId))) {
      return { ok: false, status: 404 };
    }
    const row = await loadRow(sql, actor.userId, documentId);
    if (row === undefined) {
      return { ok: false, status: 404 };
    }
    const key = await activeDek(sql, kek, actor);
    const current = key === undefined ? undefined : stateOf(row, key.dek);
    const size = key === undefined ? undefined : projectionOf(row, key.dek).baseFontSizePt;
    forget(key?.dek);
    if (current === undefined || size === undefined) {
      if (patch.title !== undefined || patch.baseFontSizePt !== undefined) {
        return { ok: false, status: 500 };
      }
      await sql.query(
        `UPDATE flaw.documents
         SET format = $3, font = $4, updated_at = now(), revision = revision + 1
         WHERE id = $1 AND owner_id = $2`,
        [documentId, actor.userId, patch.pageFormat ?? row.format, patch.fontFamily ?? row.font],
      );
      const saved = await loadRow(sql, actor.userId, documentId);
      if (saved === undefined) {
        return { ok: false, status: 404 };
      }
      return { ok: true, document: viewOf(saved, projectionOf(saved, undefined)) };
    }
    const described = describeDocument(
      patch.title === undefined ? current : replaceTitle(current, patch.title),
      patch.baseFontSizePt ?? size,
    );
    const saved = await writeRow(sql, actor, kek, row, {
      mode: row.mode,
      format: patch.pageFormat ?? row.format,
      font: patch.fontFamily ?? row.font,
      described,
      deletedAt: "keep",
    });
    if (saved === undefined) {
      return { ok: false, status: 500 };
    }
    return { ok: true, document: saved };
  });
}

export async function deleteDocument(
  pool: Pool,
  actor: AccessActor,
  kek: Uint8Array | undefined,
  documentId: string,
  permanent: boolean,
): Promise<{ ok: true } | StoreFailure> {
  if (!validActor(actor)) {
    return { ok: false, status: 404 };
  }
  return withActor(pool, actor.userId, async (sql) => {
    if (!(await allowed(sql, actor, "delete", documentId))) {
      return { ok: false, status: 404 };
    }
    if (permanent) {
      const removed = await sql.query(`DELETE FROM flaw.documents WHERE id = $1 AND owner_id = $2`, [
        documentId,
        actor.userId,
      ]);
      return (removed.rowCount ?? 0) === 1 ? { ok: true } : { ok: false, status: 404 };
    }
    const row = await loadRow(sql, actor.userId, documentId);
    if (row === undefined) {
      return { ok: false, status: 404 };
    }
    if (kek !== undefined) {
      const key = await activeDek(sql, kek, actor);
      const doc = key === undefined ? undefined : stateOf(row, key.dek);
      const size = key === undefined ? EMPTY_PROJECTION.baseFontSizePt : projectionOf(row, key.dek).baseFontSizePt;
      forget(key?.dek);
      if (doc !== undefined) {
        const described = describeDocument(doc, size);
        const saved = await writeRow(sql, actor, kek, row, {
          mode: row.mode,
          format: row.format,
          font: row.font,
          described,
          deletedAt: new Date(),
        });
        if (saved === undefined) {
          return { ok: false, status: 500 };
        }
        return { ok: true };
      }
    }
    const marked = await sql.query(
      `UPDATE flaw.documents SET deleted_at = now(), updated_at = now(), revision = revision + 1
       WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL`,
      [documentId, actor.userId],
    );
    if ((marked.rowCount ?? 0) === 1 || row.deleted_at !== null) {
      return { ok: true };
    }
    return { ok: false, status: 404 };
  });
}

export async function restoreDocument(
  pool: Pool,
  actor: AccessActor,
  kek: Uint8Array | undefined,
  documentId: string,
): Promise<{ ok: true; document: DocumentView } | StoreFailure> {
  if (!validActor(actor) || kek === undefined) {
    return { ok: false, status: kek === undefined ? 500 : 404 };
  }
  return withActor(pool, actor.userId, async (sql) => {
    if (!(await allowed(sql, actor, "update", documentId))) {
      return { ok: false, status: 404 };
    }
    const row = await loadRow(sql, actor.userId, documentId);
    if (row === undefined) {
      return { ok: false, status: 404 };
    }
    const key = await activeDek(sql, kek, actor);
    const doc = key === undefined ? undefined : stateOf(row, key.dek);
    const size = key === undefined ? undefined : projectionOf(row, key.dek).baseFontSizePt;
    forget(key?.dek);
    if (doc === undefined || size === undefined) {
      return { ok: false, status: 500 };
    }
    const described = describeDocument(doc, size);
    const saved = await writeRow(sql, actor, kek, row, {
      mode: row.mode,
      format: row.format,
      font: row.font,
      described,
      deletedAt: null,
    });
    if (saved === undefined) {
      return { ok: false, status: 500 };
    }
    return { ok: true, document: saved };
  });
}

export async function readContent(
  pool: Pool,
  actor: AccessActor,
  kek: Uint8Array | undefined,
  documentId: string,
  format: ContentFormat,
): Promise<{ ok: true; format: ContentFormat; body: unknown } | StoreFailure> {
  if (!validActor(actor) || kek === undefined) {
    return { ok: false, status: kek === undefined ? 500 : 404 };
  }
  return withActor(pool, actor.userId, async (sql) => {
    if (!(await allowed(sql, actor, "read", documentId))) {
      return { ok: false, status: 404 };
    }
    const row = await loadRow(sql, actor.userId, documentId);
    if (row === undefined) {
      return { ok: false, status: 404 };
    }
    const key = await activeDek(sql, kek, actor);
    const doc = key === undefined ? undefined : stateOf(row, key.dek);
    forget(key?.dek);
    if (doc === undefined) {
      return { ok: false, status: 404 };
    }
    if (format === "text") {
      return { ok: true, format, body: documentPlainText(doc) };
    }
    if (format === "markdown") {
      return { ok: true, format, body: documentMarkdown(doc) };
    }
    return { ok: true, format, body: doc.toJSON() };
  });
}

export async function touchSync(pool: Pool, actor: AccessActor, documentId: string): Promise<true | StoreFailure> {
  if (!validActor(actor)) {
    return { ok: false, status: 404 };
  }
  return withActor(pool, actor.userId, async (sql) => {
    if (!(await allowed(sql, actor, "sync", documentId))) {
      return { ok: false, status: 404 };
    }
    return true;
  });
}
