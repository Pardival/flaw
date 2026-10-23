/**
 * Q-011 — révocation explicite. Le statut `revoked` (migration additive)
 * refuse la résolution. `retired` reste résoluble. L'opération est auditée.
 */
import type { Pool } from "pg";

import { dekResolvable, type KeyStatus } from "@flaw/crypto";

import { insertAudit } from "../auth/store.ts";
import { writeSecurityLog, type SecurityEvent } from "../platform/security-log.ts";
import type { Writable } from "node:stream";

export function resolvedDek(status: KeyStatus, dek: Uint8Array): Uint8Array | undefined {
  if (!dekResolvable(status)) {
    return undefined;
  }
  return dek;
}

export async function revokeDek(
  pool: Pool,
  userId: string,
  dekId: string,
  stream: Writable,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    const updated = await client.query(
      `UPDATE flaw.user_keys
       SET status = 'revoked'
       WHERE id = $1 AND owner_id = $2 AND status <> 'revoked'
       RETURNING id`,
      [dekId, userId],
    );
    if ((updated.rowCount ?? 0) !== 1) {
      return false;
    }
    await insertAudit(client, userId, "admin.revoke_dek", "ok");
    const event: SecurityEvent = {
      type: "admin_action",
      result: "succes",
      userId,
      ip: null,
      userAgent: null,
      action: "admin.revoke_dek",
    };
    writeSecurityLog(stream, event);
    return true;
  } finally {
    client.release();
  }
}
