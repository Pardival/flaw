import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { buildOpenApiDocument } from "./openapi.ts";
import { mfaRequiredProblem, problem } from "./problem.ts";

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

  it("refuse le 403 générique à la place du corps MfaRequired", () => {
    const contract = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../openapi/api-contract-0.4.18-derive-t052.json", import.meta.url)), "utf8"),
    ) as {
      components: {
        responses: {
          MfaRequired: {
            description: string;
            content: { "application/problem+json": { schema: { $ref: string } } };
          };
        };
        schemas: { Problem: { properties: { type: { format: string }; status: { type: string } } } };
      };
    };
    const response = contract.components.responses.MfaRequired;
    expect(Object.keys(response.content)).toEqual(["application/problem+json"]);
    expect(response.content["application/problem+json"].schema.$ref).toBe("#/components/schemas/Problem");
    expect(response.description).toContain("mfa_required");
    expect(contract.components.schemas.Problem.properties.type.format).toBe("uri");
    expect(contract.components.schemas.Problem.properties.status.type).toBe("integer");
    const body = mfaRequiredProblem();
    expect(body).toEqual({
      type: "https://flaw.example.com/problems/mfa_required",
      status: 403,
      title: "Second facteur requis",
      code: "mfa_required",
    });
    expect(new URL(body.type).pathname.endsWith("/mfa_required")).toBe(true);
    const generic = problem(403, "session restreinte");
    expect(generic).toEqual({
      type: "about:blank",
      status: 403,
      title: "Accès refusé",
      code: "forbidden",
      detail: "session restreinte",
    });
    expect(generic).not.toEqual(body);
    expect(() => {
      expect(generic).toEqual(body);
    }).toThrow();
  });
});