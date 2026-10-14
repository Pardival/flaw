/**
 * OpenAPI 3.1 produit depuis les schémas Zod (A-015).
 * Le document commité est openapi.json ; la CI le compare avec oasdiff.
 */
import { z } from "zod";

import { PROBLEM_CODES } from "./problem.ts";
import { documentTitleSchema } from "./validation.ts";

export const healthResponseSchema = z
  .object({
    status: z.literal("ok"),
    clientIp: z.string(),
  })
  .strict();

export const problemSchema = z
  .object({
    type: z.literal("about:blank"),
    status: z.union([z.literal(400), z.literal(404), z.literal(413), z.literal(500)]),
    title: z.string(),
    code: z.enum(PROBLEM_CODES),
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
      schema: { $ref: "#/components/schemas/Problem" },
    },
  },
};

export function buildOpenApiDocument(): Record<string, unknown> {
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
    },
    components: {
      schemas: {
        Problem: jsonSchema(problemSchema),
        DocumentTitle: jsonSchema(documentTitleSchema),
      },
    },
  };
}
