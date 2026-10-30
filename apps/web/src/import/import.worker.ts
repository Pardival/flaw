/// <reference lib="webworker" />
import { ImportError, importFileAsync, type ImportErrorCode, type ImportResult } from "@flaw/importers/src/index.ts";

/**
 * Worker d'import (SEC-IMP-01) : un par fichier, tué à 30 s ou sur Annuler par la page.
 * Aucun accès réseau : chaque API réseau est neutralisée avant toute lecture du fichier.
 */
export type ImportRequest = { bytes: Uint8Array; name: string };
export type ImportResponse = { ok: true; result: ImportResult } | { ok: false; code: ImportErrorCode };

const scope = self as unknown as DedicatedWorkerGlobalScope & Record<string, unknown>;

function blocked(): never {
  throw new Error("réseau interdit dans le worker d'import");
}

for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "WebTransport"]) {
  try {
    Object.defineProperty(scope, name, { value: blocked, configurable: false, writable: false });
  } catch {
    // Propriété déjà verrouillée : la CSP connect-src 'self' reste la barrière.
  }
}
try {
  Object.defineProperty(scope.navigator, "sendBeacon", { value: blocked, configurable: false });
} catch {
  // Rien.
}

scope.onmessage = async (event: MessageEvent<ImportRequest>) => {
  try {
    const result = await importFileAsync(event.data.bytes, event.data.name);
    scope.postMessage({ ok: true, result } satisfies ImportResponse);
  } catch (error) {
    const code: ImportErrorCode = error instanceof ImportError ? error.code : "xml";
    scope.postMessage({ ok: false, code } satisfies ImportResponse);
  }
};
