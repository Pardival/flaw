/**
 * Décisions du handshake WebSocket /api/v1/sync (SEC-API-06, A-008).
 * Pures : pas de Yjs, pas de socket. Le serveur Hocuspocus s'en sert.
 */
import { clientTooOld, parseSchemaHeader } from "../../../../packages/sync/src/index.ts";

export const SYNC_PATH = "/api/v1/sync";

export type UpgradeRefusal = 403 | 426;

export function revalidationDelayMs(seconds: number): number {
  if (!Number.isInteger(seconds) || seconds < 1) {
    return 30_000;
  }
  return seconds * 1000;
}

export function originAllowed(origin: string | undefined, allowed: ReadonlySet<string>): boolean {
  return origin !== undefined && allowed.has(origin);
}

export function messageTooLarge(byteLength: number, limit: number): boolean {
  return byteLength > limit;
}

/**
 * 403 si l'origine n'est pas de confiance, 426 si le client est trop ancien
 * pour le schéma connu au handshake. Le schéma du texte est revu ensuite.
 */
export function upgradeRefusal(
  input: {
    path: string;
    origin: string | undefined;
    schemaHeader: string | undefined;
    documentSchema: number;
  },
  allowedOrigins: ReadonlySet<string>,
): UpgradeRefusal | undefined {
  if (input.path !== SYNC_PATH) {
    return 403;
  }
  if (!originAllowed(input.origin, allowedOrigins)) {
    return 403;
  }
  if (clientTooOld(parseSchemaHeader(input.schemaHeader), input.documentSchema)) {
    return 426;
  }
  return undefined;
}
