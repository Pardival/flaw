/* eslint-disable @typescript-eslint/no-explicit-any -- fixture Semgrep SEC-DB-03, non exécutée */
import { sql } from "drizzle-orm";

export async function bad1(db: any, req: any) {
  const q = "SELECT * FROM documents WHERE title = '" + req.query.title + "'";
  return db.query(q);                                  // ruleid: les deux
}
export async function bad2(db: any, id: string) {
  let q = `SELECT * FROM t WHERE id = ${id}`;
  q += " ORDER BY " + id;
  return db.execute(q);                                // ruleid: les deux
}
export async function bad3(db: any, cols: string) {
  return db.execute(sql.raw(cols));                    // ruleid
}
export async function bad4(db: any, q: string) {
  return db.query(q);                                  // ruleid (non-literal)
}
export async function ok1(db: any, id: string) {
  return db.query("SELECT * FROM t WHERE id = $1", [id]);
}
export async function ok2(db: any, id: string) {
  return db.execute(sql`SELECT * FROM t WHERE id = ${id}`);
}
export async function ok3(db: any, id: string) {
  const stmt = sql`SELECT * FROM t WHERE id = ${id}`;
  return db.execute(stmt);
}
export async function ok4(db: any) {
  return db.query(`SELECT 1`);
}
