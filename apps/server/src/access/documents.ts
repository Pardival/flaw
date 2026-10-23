/**
 * Couche d'accès aux textes. Chaque requête porte owner_id de l'acteur,
 * jamais un owner_id fourni par le client. can() décide avant l'écriture.
 */
import type { Pool } from "pg";

import {
  ACCESS_DENIED,
  ACCESS_GRANTED,
  can,
  validActor,
  type AccessActor,
  type CanResult,
  type DocumentAction,
} from "./can.ts";
import { withActor } from "./scope.ts";
import type { Sql } from "./sql.ts";

async function scoped(
  pool: Pool,
  actor: AccessActor,
  action: DocumentAction,
  documentId: string,
  run: (sql: Sql) => Promise<CanResult>,
): Promise<CanResult> {
  if (!validActor(actor)) {
    return ACCESS_DENIED;
  }
  return withActor(pool, actor.userId, async (sql) => {
    const decision = await can(sql, actor, action, { type: "document", id: documentId });
    if (!decision.ok) {
      return ACCESS_DENIED;
    }
    return run(sql);
  });
}

export async function listOwnedDocuments(pool: Pool, actor: AccessActor): Promise<string[]> {
  if (!validActor(actor)) {
    return [];
  }
  return withActor(pool, actor.userId, async (sql) => {
    const decision = await can(sql, actor, "read", { type: "documents" });
    if (!decision.ok) {
      return [];
    }
    const result = await sql.query<{ id: string }>(
      "SELECT id FROM flaw.documents WHERE owner_id = $1 ORDER BY created_at",
      [actor.userId],
    );
    return result.rows.map((row) => row.id);
  });
}

export async function readDocument(
  pool: Pool,
  actor: AccessActor,
  documentId: string,
): Promise<typeof ACCESS_DENIED | { ok: true; id: string }> {
  if (!validActor(actor)) {
    return ACCESS_DENIED;
  }
  return withActor(pool, actor.userId, async (sql) => {
    const decision = await can(sql, actor, "read", { type: "document", id: documentId });
    if (!decision.ok) {
      return ACCESS_DENIED;
    }
    const result = await sql.query<{ id: string }>(
      "SELECT id FROM flaw.documents WHERE id = $1 AND owner_id = $2",
      [documentId, actor.userId],
    );
    const id = result.rows[0]?.id;
    if (id === undefined) {
      return ACCESS_DENIED;
    }
    return { ok: true, id };
  });
}

async function writeFont(
  pool: Pool,
  actor: AccessActor,
  action: "update" | "patch",
  documentId: string,
  font: string,
): Promise<CanResult> {
  return scoped(pool, actor, action, documentId, async (sql) => {
    const result = await sql.query(
      "UPDATE flaw.documents SET font = $3, updated_at = now() WHERE id = $1 AND owner_id = $2",
      [documentId, actor.userId, font],
    );
    return (result.rowCount ?? 0) === 1 ? ACCESS_GRANTED : ACCESS_DENIED;
  });
}

export function updateDocument(
  pool: Pool,
  actor: AccessActor,
  documentId: string,
  font: string,
): Promise<CanResult> {
  return writeFont(pool, actor, "update", documentId, font);
}

export function patchDocument(
  pool: Pool,
  actor: AccessActor,
  documentId: string,
  font: string,
): Promise<CanResult> {
  return writeFont(pool, actor, "patch", documentId, font);
}

export function deleteOwnedDocument(
  pool: Pool,
  actor: AccessActor,
  documentId: string,
): Promise<CanResult> {
  return scoped(pool, actor, "delete", documentId, async (sql) => {
    const result = await sql.query(
      "DELETE FROM flaw.documents WHERE id = $1 AND owner_id = $2",
      [documentId, actor.userId],
    );
    return (result.rowCount ?? 0) === 1 ? ACCESS_GRANTED : ACCESS_DENIED;
  });
}

export function exportDocument(pool: Pool, actor: AccessActor, documentId: string): Promise<CanResult> {
  return scoped(pool, actor, "export", documentId, async (sql) => {
    const result = await sql.query<{ id: string }>(
      "SELECT id FROM flaw.documents WHERE id = $1 AND owner_id = $2",
      [documentId, actor.userId],
    );
    return result.rows.length === 1 ? ACCESS_GRANTED : ACCESS_DENIED;
  });
}
