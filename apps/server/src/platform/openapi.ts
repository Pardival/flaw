/**
 * OpenAPI 3.1 aligné sur le contrat 0.4.18 (A-015).
 * Les chemins du contrat sont préfixés par /api/v1 (porté par l'URL serveur).
 * Le nom du cookie de session est celui de l'application.
 * Le document commité est openapi.json ; la CI le compare avec oasdiff.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { SESSION_COOKIE } from "../auth/cookie.ts";

type Json = Record<string, unknown>;

function readArchitectContract(): Json {
  const path = fileURLToPath(new URL("../../openapi/api-contract-0.4.18-derive-t052.json", import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as Json;
}

function prefixPaths(paths: Json): Json {
  const output: Json = {};
  for (const [path, item] of Object.entries(paths)) {
    output[`/api/v1${path}`] = item;
  }
  return output;
}

export const healthResponseSchema = z
  .object({
    status: z.literal("ok"),
  })
  .strict();

export const meResponseSchema = z
  .object({
    id: z.uuid(),
    email: z.email(),
    role: z.enum(["user", "admin"]),
    locale: z.string().min(1),
    timeZone: z.string().min(1),
    mfaEnrolled: z.boolean(),
    passwordMustChange: z.boolean(),
  })
  .strict();

export function buildOpenApiDocument(): Record<string, unknown> {
  const contract = readArchitectContract();
  const document = structuredClone(contract);
  const components = document.components as Json;
  const schemes = components.securitySchemes as Json;
  const sessionCookie = schemes.sessionCookie as Json;
  sessionCookie.name = SESSION_COOKIE;
  document.paths = prefixPaths(contract.paths as Json);
  return document;
}
