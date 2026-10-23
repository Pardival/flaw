/**
 * OpenAPI 3.1 produit depuis les schémas Zod (A-015).
 * GET /me reprend l'opération de l'architecte, y compris le 403 mfa_required.
 * Le document commité est openapi.json ; la CI le compare avec oasdiff.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { documentFontSchema, documentRefSchema, syncBodySchema } from "../access/schema.ts";
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

function sessionOperation(operation: unknown, security: unknown, ensureMfa: boolean): Json {
  const copy = structuredClone(operation) as Json;
  copy.security = security;
  if (ensureMfa) {
    const responses = copy.responses as Json;
    if (responses["403"] === undefined) {
      responses["403"] = { $ref: "#/components/responses/MfaRequired" };
    }
  }
  return copy;
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

const documentIdParameter = {
  name: "id",
  in: "path" as const,
  required: true,
  schema: { type: "string", format: "uuid" },
};

function documentWrite(operationId: string, summary: string, body: z.ZodType, done: string) {
  return {
    operationId,
    summary,
    security: sessionSecurity,
    parameters: [documentIdParameter],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: jsonSchema(body),
        },
      },
    },
    responses: {
      "204": { description: done },
      "400": problemResponse,
      "401": unauthorizedResponse,
      "403": forbiddenResponse,
      "404": problemResponse,
    },
  };
}

export function buildOpenApiDocument(): Record<string, unknown> {
  const contract = readArchitectContract();
  const architectPaths = contract.paths as Json;
  const sessionCollection = architectPaths["/me/sessions"] as Json;
  const sessionItem = architectPaths["/me/sessions/{sessionId}"] as Json;
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
      "/api/v1/me/sessions": {
        get: sessionOperation(sessionCollection.get, sessionSecurity, true),
        delete: sessionOperation(sessionCollection.delete, sessionSecurity, false),
      },
      "/api/v1/me/sessions/{sessionId}": {
        delete: sessionOperation(sessionItem.delete, sessionSecurity, true),
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
        get: {
          operationId: "getDocument",
          summary: "Texte du compte connecté",
          security: sessionSecurity,
          parameters: [documentIdParameter],
          responses: {
            "200": {
              description: "Texte",
              content: {
                "application/json": {
                  schema: jsonSchema(documentRefSchema),
                },
              },
            },
            "401": unauthorizedResponse,
            "403": forbiddenResponse,
            "404": problemResponse,
          },
        },
        put: documentWrite("putDocument", "Remplace la police d'un texte du compte connecté", documentFontSchema, "Mis à jour"),
        patch: documentWrite("patchDocument", "Modifie la police d'un texte du compte connecté", documentFontSchema, "Mis à jour"),
        delete: {
          operationId: "deleteDocument",
          summary: "Supprime un document du compte connecté",
          security: sessionSecurity,
          parameters: [documentIdParameter],
          responses: {
            "204": { description: "Supprimé" },
            "401": unauthorizedResponse,
            "403": forbiddenResponse,
            "404": problemResponse,
          },
        },
      },
      "/api/v1/documents/{id}/sync": {
        post: documentWrite(
          "syncDocument",
          "Autorise la synchronisation d'un texte du compte connecté",
          syncBodySchema,
          "Autorisé",
        ),
      },
      "/api/v1/documents/{id}/export": {
        post: documentWrite(
          "exportDocument",
          "Autorise l'export d'un texte du compte connecté",
          syncBodySchema,
          "Autorisé",
        ),
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
        ReauthRequired: responses.ReauthRequired,
        NotFound: responses.NotFound,
      },
      schemas: {
        User: schemas.User,
        Session: schemas.Session,
        Problem: schemas.Problem,
        ServiceProblem: jsonSchema(problemSchema),
        UnauthorizedBody: jsonSchema(unauthorizedProblemSchema),
        DocumentTitle: jsonSchema(documentTitleSchema),
      },
    },
  };
}
