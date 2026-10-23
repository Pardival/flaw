/**
 * Autorisation unique (A-014). REST et sync passent par can().
 * Le rôle admin n'ouvre aucun texte : seul owner_id compte.
 * Inexistant et interdit renvoient le même refus, sans motif.
 */
import { isUuid, type Sql } from "./sql.ts";

export const DOCUMENT_ACTIONS = ["read", "update", "patch", "delete", "sync", "export"] as const;

export type DocumentAction = (typeof DOCUMENT_ACTIONS)[number];

export type AccessActor = {
  userId: string;
  role: "user" | "admin";
};

export type AccessTarget = { type: "document"; id: string } | { type: "documents" };

export const ACCESS_DENIED = { ok: false } as const;
export const ACCESS_GRANTED = { ok: true } as const;

export type CanResult = typeof ACCESS_DENIED | typeof ACCESS_GRANTED;

const ACTIONS = new Set<string>(DOCUMENT_ACTIONS);

export function validActor(actor: AccessActor): boolean {
  return (actor.role === "user" || actor.role === "admin") && isUuid(actor.userId);
}

export async function can(
  sql: Sql,
  actor: AccessActor,
  action: DocumentAction,
  target: AccessTarget,
): Promise<CanResult> {
  if (!ACTIONS.has(action) || !validActor(actor)) {
    return ACCESS_DENIED;
  }
  if (target.type === "documents") {
    return ACCESS_GRANTED;
  }
  if (!isUuid(target.id)) {
    return ACCESS_DENIED;
  }
  const found = await sql.query<{ id: string }>(
    "SELECT id FROM flaw.documents WHERE id = $1 AND owner_id = $2",
    [target.id, actor.userId],
  );
  return found.rows.length === 1 ? ACCESS_GRANTED : ACCESS_DENIED;
}
