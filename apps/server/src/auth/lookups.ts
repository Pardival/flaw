import type { Pool } from "pg";

/**
 * Lectures des tables d'authentification dont d'autres modules ont besoin.
 * Seul apps/server/src/auth/** interroge users et sessions (règle Semgrep).
 */

/** Dernière ré-authentification de la session, si elle appartient bien au compte. */
export async function sessionReauthenticatedAt(pool: Pool, sessionId: string, ownerId: string): Promise<Date | null> {
  const result = await pool.query<{ reauthenticated_at: Date | null }>(
    "SELECT reauthenticated_at FROM flaw.sessions WHERE id = $1 AND owner_id = $2",
    [sessionId, ownerId],
  );
  return result.rows[0]?.reauthenticated_at ?? null;
}

/** Premier administrateur (purge quotidienne consignée à son nom), s'il existe. */
export async function firstAdminId(pool: Pool): Promise<string | undefined> {
  const result = await pool.query<{ id: string }>("SELECT id FROM flaw.users WHERE role = 'admin' ORDER BY id LIMIT 1");
  return result.rows[0]?.id;
}
