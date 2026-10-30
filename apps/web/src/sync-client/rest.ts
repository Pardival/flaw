import { decodeSyncRequest, encodeSyncRequest } from "@flaw/sync/src/index.ts";

import { CSRF_HEADER, CSRF_VALUE } from "../auth-ui/api.ts";
import { base64ToBytes } from "../local-store/coding.ts";
import type { LocalStore, RestOperation } from "../local-store/index.ts";
import { DOCUMENT_MODES, type DocumentMode } from "../local-store/index.ts";
import { defaultFormat } from "../library/formats-by-mode.ts";
import { isLive } from "./connection.ts";
import { updateSync } from "./status.ts";

function isMode(value: string): value is DocumentMode {
  return (DOCUMENT_MODES as readonly string[]).includes(value);
}

/**
 * File REST idempotente (A-004) : chaque opération part avec son `Idempotency-Key`.
 * Les instantanés `…/sync` sont encodés en octets (API-016) ; la réponse apporte
 * ce qui manque à l'appareil, fusionné dans le Y.Doc local.
 * Une erreur laisse l'opération en file ; 404, 409 et 422 sont définitifs.
 */
export function makeSender(store: () => LocalStore | null): (operation: RestOperation) => Promise<void> {
  return async (operation) => {
    const headers = new Headers(operation.headers);
    headers.set(CSRF_HEADER, CSRF_VALUE);
    let body: BodyInit | null = operation.body;
    const sync = operation.path.endsWith("/sync");
    if (sync && isLive(operation.documentId)) {
      // Texte déjà à jour par le WebSocket : le repli HTTP n'a rien à apporter.
      return;
    }
    if (sync && operation.body !== null) {
      const parsed = JSON.parse(operation.body) as { stateVector?: string; update?: string };
      body = encodeSyncRequest(base64ToBytes(parsed.stateVector ?? ""), base64ToBytes(parsed.update ?? "")) as BodyInit;
      headers.set("content-type", "application/octet-stream");
    } else if (operation.body !== null) {
      headers.set("content-type", "application/json");
    }
    let response: Response;
    try {
      response = await fetch(operation.path, { method: operation.method, headers, body, credentials: "same-origin" });
    } catch (error) {
      updateSync({ online: navigator.onLine });
      throw error;
    }
    if (response.status === 401) {
      updateSync({ authExpired: true });
      throw new Error("session");
    }
    if (response.status === 426) {
      // Client trop ancien : lecture seule jusqu'à la mise à jour (D-043).
      updateSync({ updateRequired: true });
      throw new Error("mise à jour");
    }
    if (sync && response.ok) {
      // La réponse a la même forme que la requête : 1er bloc = mise à jour manquante, 2e = vecteur serveur.
      const reply = decodeSyncRequest(new Uint8Array(await response.arrayBuffer()));
      const missing = reply?.stateVector;
      const current = store();
      if (missing !== undefined && missing.length > 2 && current !== null) {
        await current.importUpdate(operation.documentId, missing).catch(() => undefined);
      }
      return;
    }
    if (response.ok || response.status === 404 || response.status === 409 || response.status === 422) {
      return;
    }
    throw new Error(`envoi refusé : ${String(response.status)}`);
  };
}

type RemoteList = {
  items: Array<{
    id: string;
    title: string;
    mode: string;
    wordCount: number;
    excerpt?: string;
    updatedAt: string;
    deletedAt: string | null;
    pageFormat?: string;
  }>;
  nextCursor: string | null;
};

/**
 * Liste serveur → stockage local (AC-026) : un texte créé ou renommé sur un autre
 * appareil apparaît ici. Les textes en corbeille ailleurs le restent ici aussi.
 */
export async function pullRemoteList(store: LocalStore): Promise<void> {
  await pullPages(store, false);
  await pullPages(store, true);
}

async function pullPages(store: LocalStore, trashed: boolean): Promise<void> {
  let cursor: string | null = null;
  for (let page = 0; page < 50; page += 1) {
    const base = `?limit=200&trashed=${String(trashed)}`;
    const query: string = cursor === null ? base : `${base}&cursor=${encodeURIComponent(cursor)}`;
    let response: Response;
    try {
      response = await fetch(`/api/v1/documents${query}`, { credentials: "same-origin" });
    } catch {
      return;
    }
    if (response.status === 401) {
      updateSync({ authExpired: true });
      return;
    }
    if (!response.ok) {
      return;
    }
    const list = (await response.json()) as RemoteList;
    for (const item of list.items) {
      const local = (await store.listDocuments()).find((doc) => doc.id === item.id);
      await store
        .upsertRemote({
          id: item.id,
          title: item.title,
          mode: item.mode,
          pageFormat: item.pageFormat ?? local?.pageFormat ?? (isMode(item.mode) ? defaultFormat(item.mode) : "a4"),
          wordCount: item.wordCount,
          excerpt: typeof item.excerpt === "string" ? item.excerpt : undefined,
          updatedAt: item.updatedAt,
          deletedAt: item.deletedAt,
        })
        .catch(() => undefined);
    }
    if (list.nextCursor === null) {
      return;
    }
    cursor = list.nextCursor;
  }
}
