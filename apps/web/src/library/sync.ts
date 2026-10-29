import { CSRF_HEADER, CSRF_VALUE } from "../auth-ui/api.ts";
import type { RestOperation } from "../local-store/index.ts";

/**
 * Envoi d'une opération REST de la file locale (A-004). Idempotent par `Idempotency-Key`.
 * Une erreur laisse l'opération en file ; 409 et 422 sont définitifs (rejouer ne changerait rien).
 */
export async function sendOperation(operation: RestOperation): Promise<void> {
  const headers = new Headers(operation.headers);
  headers.set(CSRF_HEADER, CSRF_VALUE);
  if (operation.body !== null) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(operation.path, {
    method: operation.method,
    headers,
    body: operation.body,
    credentials: "same-origin",
  });
  if (response.ok || response.status === 409 || response.status === 422 || response.status === 404) {
    return;
  }
  throw new Error(`envoi refusé : ${String(response.status)}`);
}
