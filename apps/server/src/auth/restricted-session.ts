/**
 * Session restreinte (A-012, G2) : 15 minutes, liste blanche.
 * L'enrôlement TOTP n'est possible que dans cette session, ouverte avec
 * le mot de passe provisoire. Le reste de l'OpenAPI est refusé.
 */
export const RESTRICTED_TTL_MS = 15 * 60 * 1000;

/** Routes Fastify autorisées pendant la session restreinte. */
export const RESTRICTED_ALLOW = [
  "POST /api/auth/change-password",
  "POST /api/auth/sign-out",
  "POST /api/auth/mfa/enroll",
  "POST /api/auth/mfa/verify",
] as const;

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

export function restrictedAllows(method: string, url: string): boolean {
  const normalized = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  return (RESTRICTED_ALLOW as readonly string[]).includes(`${normalized} ${url}`);
}

export function openApiPathToRoute(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ":$1");
}

export type OpenApiOperation = {
  method: string;
  path: string;
};

export function openApiOperations(document: { paths?: Record<string, unknown> }): OpenApiOperation[] {
  const operations: OpenApiOperation[] = [];
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    if (item === null || typeof item !== "object") {
      continue;
    }
    for (const method of Object.keys(item)) {
      if (HTTP_METHODS.has(method.toLowerCase())) {
        operations.push({ method: method.toUpperCase(), path });
      }
    }
  }
  return operations;
}

export type RestrictedDecision = "public" | "allow" | "deny";

export function restrictedDecision(method: string, path: string, isPublic: boolean): RestrictedDecision {
  if (isPublic) {
    return "public";
  }
  return restrictedAllows(method, openApiPathToRoute(path)) ? "allow" : "deny";
}
