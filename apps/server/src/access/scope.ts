/**
 * Transaction applicative : `app.user_id` est local à la transaction (RLS)
 * et disparaît au COMMIT. Le rôle applicatif ne contourne pas la RLS.
 */
import type { Pool, PoolClient } from "pg";

import { isUuid, type Sql } from "./sql.ts";

export async function withActor<T>(pool: Pool, userId: string, run: (sql: Sql) => Promise<T>): Promise<T> {
  if (!isUuid(userId)) {
    throw new Error("acteur invalide");
  }
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
