/**
 * Objectif quotidien (API-021, API-022) : un compteur par appareil et par jour local,
 * fusion par maximum (G-Counter) ; le total d'un jour est la somme des appareils.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";

import { sendProblem } from "../platform/problem.ts";

const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const bodySchema = z.object({ wordsWritten: z.number().int().min(0).max(10_000_000) }).strict();

export type StatsDeps = {
  pool: () => Pool | undefined;
  userId: (request: FastifyRequest) => string | undefined;
};

function invalid(reply: import("fastify").FastifyReply): unknown {
  return reply
    .code(422)
    .header("content-type", "application/problem+json; charset=utf-8")
    .send({ type: "about:blank", status: 422, title: "Données invalides", code: "invalid_request" });
}

export function registerStats(app: FastifyInstance, deps: StatsDeps): void {
  app.get("/api/v1/stats/daily", async (request, reply) => {
    const pool = deps.pool();
    const userId = deps.userId(request);
    if (pool === undefined || userId === undefined) {
      return sendProblem(reply, 401);
    }
    const query = request.query as Record<string, unknown>;
    const from = typeof query.from === "string" ? query.from : "";
    const to = typeof query.to === "string" ? query.to : "";
    if (!DAY.test(from) || !DAY.test(to) || from > to) {
      return invalid(reply);
    }
    const days = await pool.query<{ day: string; words: string }>(
      `SELECT day::text AS day, SUM(progress_count)::text AS words
       FROM flaw.daily_progress WHERE owner_id = $1 AND day BETWEEN $2::date AND $3::date
       GROUP BY day ORDER BY day`,
      [userId, from, to],
    );
    const prefs = await pool.query<{ goal: unknown }>(
      "SELECT settings->'dailyWordGoal' AS goal FROM flaw.user_preferences WHERE owner_id = $1",
      [userId],
    );
    const goal = typeof prefs.rows[0]?.goal === "number" ? prefs.rows[0].goal : 500;
    return reply.header("cache-control", "no-store").send({
      goal,
      days: days.rows.map((row) => ({ day: row.day, wordsWritten: Number(row.words) })),
    });
  });

  app.put("/api/v1/stats/daily/:day/devices/:deviceId", async (request, reply) => {
    const pool = deps.pool();
    const userId = deps.userId(request);
    if (pool === undefined || userId === undefined) {
      return sendProblem(reply, 401);
    }
    const params = request.params as { day?: string; deviceId?: string };
    const body = bodySchema.safeParse(request.body);
    if (!DAY.test(params.day ?? "") || !UUID.test(params.deviceId ?? "") || !body.success) {
      return invalid(reply);
    }
    await pool.query(
      `INSERT INTO flaw.daily_progress (owner_id, day, device_id, progress_count)
       VALUES ($1, $2::date, $3::uuid, $4)
       ON CONFLICT (owner_id, day, device_id)
       DO UPDATE SET progress_count = GREATEST(flaw.daily_progress.progress_count, EXCLUDED.progress_count)`,
      [userId, params.day, params.deviceId?.toLowerCase(), body.data.wordsWritten],
    );
    return reply.code(204).send();
  });
}
