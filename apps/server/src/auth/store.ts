/**
 * Accès SQL aux tables d'authentification. Seul ce module (et le reste de auth/)
 * interroge users, accounts et sessions.
 */
import type { Pool, PoolClient } from "pg";

export type Sql = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
};

export type AccountRow = {
  user_id: string;
  role: string;
  password_hash: string | null;
};

export type SessionRow = {
  id: string;
  owner_id: string;
  expires_at: Date;
  absolute_expires_at: Date;
  last_activity_at: Date;
  revoked_at: Date | null;
  remember: boolean;
  created_at: Date;
};

export type AuditRow = {
  id: string;
  owner_id: string;
  event_type: string;
  result: string;
  created_at: Date;
};

const ABSENT_USER = "00000000-0000-0000-0000-000000000000";

export async function withOwner<T>(pool: Pool, userId: string, run: (sql: Sql) => Promise<T>): Promise<T> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function countUsers(sql: Sql): Promise<number> {
  const result = await sql.query<{ n: number }>("SELECT count(*)::int AS n FROM flaw.users");
  return result.rows[0]?.n ?? 0;
}

export async function insertUser(sql: Sql): Promise<string> {
  const result = await sql.query<{ id: string }>(
    "INSERT INTO flaw.users (role) VALUES ('user') RETURNING id",
  );
  const id = result.rows[0]?.id;
  if (id === undefined) {
    throw new Error("création impossible");
  }
  return id;
}

export async function insertAccount(
  sql: Sql,
  userId: string,
  identifier: string,
  passwordHash: string,
): Promise<void> {
  await sql.query(
    `INSERT INTO flaw.accounts (owner_id, provider_id, account_id, password_hash)
     VALUES ($1, 'credential', $2, $3)`,
    [userId, identifier, passwordHash],
  );
}

export async function findAccount(sql: Sql, identifier: string): Promise<AccountRow | null> {
  const result = await sql.query<AccountRow>(
    `SELECT u.id AS user_id, u.role, a.password_hash
     FROM flaw.accounts a
     JOIN flaw.users u ON u.id = a.owner_id
     WHERE a.provider_id = 'credential' AND a.account_id = $1`,
    [identifier],
  );
  return result.rows[0] ?? null;
}

export async function findAccountByUser(sql: Sql, userId: string): Promise<(AccountRow & { identifier: string }) | null> {
  const result = await sql.query<AccountRow & { identifier: string }>(
    `SELECT u.id AS user_id, u.role, a.password_hash, a.account_id AS identifier
     FROM flaw.accounts a
     JOIN flaw.users u ON u.id = a.owner_id
     WHERE a.provider_id = 'credential' AND u.id = $1`,
    [userId],
  );
  return result.rows[0] ?? null;
}

export async function setPassword(sql: Sql, userId: string, passwordHash: string): Promise<void> {
  await sql.query(
    `UPDATE flaw.accounts SET password_hash = $2
     WHERE owner_id = $1 AND provider_id = 'credential'`,
    [userId, passwordHash],
  );
}

export async function insertSession(
  sql: Sql,
  input: {
    userId: string;
    tokenHash: Buffer;
    expiresAt: Date;
    absoluteExpiresAt: Date;
    createdAt: Date;
    browser: string;
    os: string;
    remember: boolean;
  },
): Promise<string> {
  const result = await sql.query<{ id: string }>(
    `INSERT INTO flaw.sessions (
       owner_id, token_hash, expires_at, created_at, last_activity_at,
       absolute_expires_at, browser, os, remember
     ) VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      input.userId,
      input.tokenHash,
      input.expiresAt,
      input.createdAt,
      input.absoluteExpiresAt,
      input.browser,
      input.os,
      input.remember,
    ],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) {
    throw new Error("session impossible");
  }
  return id;
}

export async function findSession(sql: Sql, tokenHash: Buffer): Promise<SessionRow | null> {
  const result = await sql.query<SessionRow>(
    `SELECT id, owner_id, expires_at, absolute_expires_at, last_activity_at,
            revoked_at, remember, created_at
     FROM flaw.sessions
     WHERE token_hash = $1`,
    [tokenHash],
  );
  return result.rows[0] ?? null;
}

export async function touchSession(sql: Sql, sessionId: string, activity: Date, expiresAt: Date): Promise<void> {
  await sql.query(
    `UPDATE flaw.sessions
     SET last_activity_at = $2, expires_at = $3
     WHERE id = $1 AND revoked_at IS NULL`,
    [sessionId, activity, expiresAt],
  );
}

export async function revokeSession(sql: Sql, sessionId: string, at: Date): Promise<void> {
  await sql.query(
    "UPDATE flaw.sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL",
    [sessionId, at],
  );
}

export async function revokeOtherSessions(sql: Sql, userId: string, sessionId: string, at: Date): Promise<void> {
  await sql.query(
    `UPDATE flaw.sessions SET revoked_at = $3
     WHERE owner_id = $1 AND id <> $2 AND revoked_at IS NULL`,
    [userId, sessionId, at],
  );
}

export async function revokeAllSessions(sql: Sql, userId: string, at: Date): Promise<void> {
  await sql.query(
    "UPDATE flaw.sessions SET revoked_at = $2 WHERE owner_id = $1 AND revoked_at IS NULL",
    [userId, at],
  );
}

export async function listDevices(
  sql: Sql,
  userId: string,
  now: Date,
): Promise<Array<{ id: string; browser: string; os: string; last_activity_at: Date }>> {
  const result = await sql.query<{ id: string; browser: string; os: string; last_activity_at: Date }>(
    `SELECT id, browser, os, last_activity_at
     FROM flaw.sessions
     WHERE owner_id = $1 AND revoked_at IS NULL AND absolute_expires_at > $2 AND expires_at > $2
     ORDER BY last_activity_at DESC`,
    [userId, now],
  );
  return result.rows;
}

export async function insertAuthEvent(
  sql: Sql,
  eventType: "login_failed" | "login_rate_limited",
  subject: string,
  ip: string,
  summary: string,
): Promise<void> {
  await sql.query(
    `INSERT INTO flaw.auth_events (event_type, subject_hmac, ip_hmac, user_agent_summary)
     VALUES ($1, $2, $3, $4)`,
    [eventType, subject, ip, summary],
  );
}

export async function insertAudit(sql: Sql, userId: string, eventType: string, result: string): Promise<void> {
  await sql.query(
    "INSERT INTO flaw.audit_events (owner_id, event_type, result) VALUES ($1, $2, $3)",
    [userId, eventType, result],
  );
}

export async function listAuditEvents(pool: Pool, userId: string): Promise<AuditRow[]> {
  return withOwner(pool, userId, async (sql) => {
    const result = await sql.query<AuditRow>(
      `SELECT id, owner_id, event_type, result, created_at
       FROM flaw.audit_events
       WHERE owner_id = $1
       ORDER BY created_at`,
      [userId],
    );
    return result.rows;
  });
}

export async function insertVerification(sql: Sql, identifier: string, valueHash: string, expiresAt: Date): Promise<void> {
  await sql.query(
    "INSERT INTO flaw.verifications (identifier, value_hash, expires_at) VALUES ($1, $2, $3)",
    [identifier, valueHash, expiresAt],
  );
}

export async function findVerification(sql: Sql, identifier: string): Promise<Date | null> {
  const result = await sql.query<{ expires_at: Date }>(
    `SELECT expires_at FROM flaw.verifications
     WHERE identifier = $1
     ORDER BY expires_at DESC
     LIMIT 1`,
    [identifier],
  );
  return result.rows[0]?.expires_at ?? null;
}

export async function deleteVerification(sql: Sql, identifier: string): Promise<void> {
  await sql.query("DELETE FROM flaw.verifications WHERE identifier = $1", [identifier]);
}

export async function bumpRate(sql: Sql, bucket: string, windowStart: Date): Promise<number> {
  const result = await sql.query<{ hits: number }>(
    `INSERT INTO flaw.rate_limits (bucket, window_start, hits)
     VALUES ($1, $2, 1)
     ON CONFLICT (bucket, window_start)
     DO UPDATE SET hits = flaw.rate_limits.hits + 1
     RETURNING hits`,
    [bucket, windowStart],
  );
  return result.rows[0]?.hits ?? 1;
}

export async function activeLock(sql: Sql, bucket: string, now: Date): Promise<Date | null> {
  const result = await sql.query<{ window_start: Date }>(
    `SELECT window_start FROM flaw.rate_limits
     WHERE bucket = $1 AND window_start > $2
     ORDER BY window_start DESC
     LIMIT 1`,
    [bucket, now],
  );
  return result.rows[0]?.window_start ?? null;
}

export async function maxLockStage(sql: Sql, bucket: string): Promise<number> {
  const result = await sql.query<{ stage: number }>(
    "SELECT COALESCE(MAX(hits), 0)::int AS stage FROM flaw.rate_limits WHERE bucket = $1",
    [bucket],
  );
  return result.rows[0]?.stage ?? 0;
}

export async function insertLock(sql: Sql, bucket: string, until: Date, stage: number): Promise<void> {
  await sql.query(
    "INSERT INTO flaw.rate_limits (bucket, window_start, hits) VALUES ($1, $2, $3)",
    [bucket, until, stage],
  );
}

export async function deleteBuckets(sql: Sql, buckets: string[]): Promise<void> {
  await sql.query("DELETE FROM flaw.rate_limits WHERE bucket = ANY($1::text[])", [buckets]);
}

export async function listDocuments(pool: Pool, userId: string): Promise<string[]> {
  return withOwner(pool, userId, async (sql) => {
    const result = await sql.query<{ id: string }>(
      "SELECT id FROM flaw.documents WHERE owner_id = $1 ORDER BY created_at",
      [userId],
    );
    return result.rows.map((row) => row.id);
  });
}

export async function deleteDocument(pool: Pool, userId: string, documentId: string): Promise<boolean> {
  return withOwner(pool, userId, async (sql) => {
    const result = await sql.query(
      "DELETE FROM flaw.documents WHERE id = $1 AND owner_id = $2",
      [documentId, userId],
    );
    return (result.rowCount ?? 0) > 0;
  });
}

export function absentUserId(): string {
  return ABSENT_USER;
}
