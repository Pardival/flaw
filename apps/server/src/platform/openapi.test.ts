import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { buildOpenApiDocument } from "./openapi.ts";

describe("OpenAPI", () => {
  it("aligne le fichier commité sur le document généré depuis Zod", () => {
    const path = fileURLToPath(new URL("../../../../openapi.json", import.meta.url));
    const committed = readFileSync(path, "utf8");
    const generated = `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;
    expect(committed).toBe(generated);
  });

  it("décrit GET /api/v1/healthz sans authentification", () => {
    const document = buildOpenApiDocument();
    const paths = document.paths as {
      "/api/v1/healthz": { get: { operationId: string; security: unknown[]; responses: Record<string, unknown> } };
    };
    expect(document.openapi).toBe("3.1.0");
    expect(paths["/api/v1/healthz"].get.operationId).toBe("health");
    expect(paths["/api/v1/healthz"].get.security).toEqual([]);
    expect(paths["/api/v1/healthz"].get.responses["200"]).toBeDefined();
    expect(JSON.stringify(document)).not.toContain("/api/v1/import");
  });
});