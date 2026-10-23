/**
 * Point d'entrée de la synchronisation. can() refuse avant toute lecture.
 * Le corps client n'est pas stocké : le protocole Yjs n'est pas cette tâche.
 */
import type { Pool } from "pg";

import { ACCESS_DENIED, ACCESS_GRANTED, can, validActor, type AccessActor, type CanResult } from "./can.ts";
import { withActor } from "./scope.ts";

export async function syncDocument(pool: Pool, actor: AccessActor, documentId: string): Promise<CanResult> {
  if (!validActor(actor)) {
    return ACCESS_DENIED;
  }
  return withActor(pool, actor.userId, async (sql) => {
    const decision = await can(sql, actor, "sync", { type: "document", id: documentId });
    if (!decision.ok) {
      return ACCESS_DENIED;
    }
    const result = await sql.query<{ id: string }>(
      "SELECT id FROM flaw.documents WHERE id = $1 AND owner_id = $2",
      [documentId, actor.userId],
    );
    return result.rows.length === 1 ? ACCESS_GRANTED : ACCESS_DENIED;
  });
}
