/**
 * OpenAPI 3.1 produit depuis les schémas Zod (A-015).
 * GET /me reprend l'opération de l'architecte, y compris le 403 mfa_required.
 * Le document commité est openapi.json ; la CI le compare avec oasdiff.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { SESSION_COOKIE } from "../auth/cookie.ts";
import { documentTitleSchema } from "./validation.ts";

type Json = Record<string, unknown>;

function readArchitectContract(): Json {
  const path = fileURLToPath(new URL("../../openapi/api-contract-0.4.18-derive-t052.json", import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as Json;
}

function getMeOperation(contract: Json): Json {
  const paths = contract.paths as Json;
  const me = paths["/me"] as Json;
  return structuredClone(me.get) as Json;
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

export const documentListSchema = z
  .object({
    documents: z.array(z.object({ id: z.uuid() }).strict()),
  })
  .strict();

export const problemSchema = z
  .object({
    type: z.literal("about:blank"),
    status: z.union([z.literal(400), z.literal(404), z.literal(413), z.literal(500)]),
    title: z.string(),
    code: z.enum(["invalid_request", "not_found", "payload_too_large", "internal_error"]),
  })
  .strict();

export const unauthorizedProblemSchema = z
  .object({
    type: z.literal("about:blank"),
    status: z.literal(401),
    title: z.literal("Authentification requise"),
    code: z.literal("unauthorized"),
  })
  .strict();

function withoutSchemaKeyword(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => withoutSchemaKeyword(entry));
  }
  if (value !== null && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === "$schema") {
        continue;
      }
      output[key] = withoutSchemaKeyword(entry);
    }
    return output;
  }
  return value;
}

function jsonSchema(schema: z.ZodType): unknown {
  return withoutSchemaKeyword(z.toJSONSchema(schema));
}

const problemResponse = {
  description: "Erreur générique (RFC 9457)",
  content: {
    "application/problem+json": {
      schema: { $ref: "#/components/schemas/ServiceProblem" },
    },
  },
};

const unauthorizedResponse = {
  description: "Authentification requise",
  content: {
    "application/problem+json": {
      schema: { $ref: "#/components/schemas/UnauthorizedBody" },
    },
  },
};

/** Cookie ou Bearer : chaque objet du tableau est une alternative (contrat : sessionCookie). */
const sessionSecurity = [{ sessionCookie: [] }, { bearerAuth: [] }];

const forbiddenResponse = {
  description: "Accès refusé",
  content: {
    "application/problem+json": {
      schema: { $ref: "#/components/schemas/Problem" },
    },
  },
};

export function buildOpenApiDocument(): Record<string, unknown> {
  const contract = readArchitectContract();
  const components = contract.components as Json;
  const schemes = structuredClone(components.securitySchemes) as Json;
  const sessionCookie = schemes.sessionCookie as Json;
  sessionCookie.name = SESSION_COOKIE;
  const headers = components.headers as Json;
  const responses = components.responses as Json;
  const schemas = components.schemas as Json;
  return {
    openapi: "3.1.0",
    info: {
      title: "Flaw",
      version: "0.0.0",
    },
    paths: {
      "/api/v1/healthz": {
        get: {
          operationId: "health",
          summary: "Sonde de vie (sans authentification)",
          security: [],
          responses: {
            "200": {
              description: "Sonde de vie",
              content: {
                "application/json": {
                  schema: jsonSchema(healthResponseSchema),
                },
              },
            },
            "400": problemResponse,
            "413": problemResponse,
            "500": problemResponse,
          },
        },
      },
      "/api/v1/me": {
        get: getMeOperation(contract),
      },
      "/api/v1/documents": {
        get: {
          operationId: "listDocuments",
          summary: "Documents du compte connecté",
          security: sessionSecurity,
          responses: {
            "200": {
              description: "Documents",
              content: {
                "application/json": {
                  schema: jsonSchema(documentListSchema),
                },
              },
            },
            "401": unauthorizedResponse,
          },
        },
      },
      "/api/v1/documents/{id}": {
        delete: {
          operationId: "deleteDocument",
          summary: "Supprime un document du compte connecté",
          security: sessionSecurity,
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          responses: {
            "204": { description: "Supprimé" },
            "401": unauthorizedResponse,
            "403": forbiddenResponse,
            "404": problemResponse,
          },
        },
      },
    },
    components: {
      securitySchemes: {
        sessionCookie: schemes.sessionCookie,
        bearerAuth: schemes.bearerAuth,
      },
      headers: {
        CacheControlNoStore: headers.CacheControlNoStore,
      },
      responses: {
        Unauthorized: responses.Unauthorized,
        MfaRequired: responses.MfaRequired,
      },
      schemas: {
        User: schemas.User,
        Problem: schemas.Problem,
        ServiceProblem: jsonSchema(problemSchema),
        UnauthorizedBody: jsonSchema(unauthorizedProblemSchema),
        DocumentTitle: jsonSchema(documentTitleSchema),
      },
    },
  };
}
