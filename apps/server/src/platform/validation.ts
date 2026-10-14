/**
 * Limites SEC-API-03 et champs serveur SEC-API-07.
 * id, owner_id, dates et révision sont ignorés s'ils viennent du client.
 */
import { z } from "zod";

import { problem, type ProblemBody } from "./problem.ts";

export const SERVER_ASSIGNED_KEYS = [
  "id",
  "owner_id",
  "created_at",
  "updated_at",
  "revision",
] as const;

export const documentTitleSchema = z.string().max(300);

export function omitServerAssigned(input: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...input };
  for (const key of SERVER_ASSIGNED_KEYS) {
    delete copy[key];
  }
  return copy;
}

export type ParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: 400; body: ProblemBody };

export function parseStrict<T>(schema: z.ZodType<T>, input: unknown): ParseResult<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, status: 400, body: problem(400) };
  }
  return { ok: true, data: parsed.data };
}
