import { HocuspocusProvider, HocuspocusProviderWebsocket, WebSocketStatus } from "@hocuspocus/provider";
import { SCHEMA_VERSION } from "@flaw/schema/src/index.ts";
import { SYNC_CLOSE_UNAUTHORIZED, SYNC_PATH, SYNC_SCHEMA_PARAM } from "@flaw/sync/src/index.ts";
import * as Y from "yjs";

import { saveBeforeMerge } from "./before-merge.ts";
import { showBannerOnce, updateSync } from "./status.ts";

/**
 * Client WSS multiplexé (API-024) : une seule socket, un fournisseur par texte ouvert.
 * Le cookie de session part avec le handshake ; aucun jeton côté client (SEC-CLI-01).
 * À la reconnexion, Hocuspocus échange les vecteurs d'état et fusionne (A-004).
 */
let socket: HocuspocusProviderWebsocket | null = null;
const providers = new Map<string, HocuspocusProvider>();

function socketUrl(): string {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}${SYNC_PATH}?${SYNC_SCHEMA_PARAM}=${String(SCHEMA_VERSION)}`;
}

function refreshPending(): void {
  let pending = 0;
  for (const provider of providers.values()) {
    pending += provider.unsyncedChanges;
  }
  updateSync({ pending });
}

function sharedSocket(): HocuspocusProviderWebsocket {
  if (socket !== null) {
    return socket;
  }
  socket = new HocuspocusProviderWebsocket({
    url: socketUrl(),
    maxDelay: 30_000,
    onStatus: ({ status }) => {
      updateSync({ connected: status === WebSocketStatus.Connected });
      if (status === WebSocketStatus.Connected) {
        updateSync({ authExpired: false });
      }
    },
    onClose: ({ event }) => {
      if (event.code === SYNC_CLOSE_UNAUTHORIZED) {
        // Session révoquée ou expirée : on continue d'écrire, tout reste sur l'appareil (D-042).
        updateSync({ authExpired: true });
      }
    },
  });
  return socket;
}

export type Attachment = { provider: HocuspocusProvider; detach: () => void };

/** Relie le Y.Doc local d'un texte au serveur. Détacher ne détruit pas le Y.Doc. */
export function attachDocument(documentId: string, doc: Y.Doc, options: { localChanges: boolean } = { localChanges: false }): Attachment {
  const existing = providers.get(documentId);
  if (existing !== undefined) {
    existing.destroy();
    providers.delete(documentId);
  }
  const provider = new HocuspocusProvider({
    websocketProvider: sharedSocket(),
    name: documentId,
    document: doc,
    awareness: null,
    token: null,
    onUnsyncedChanges: () => {
      refreshPending();
    },
    onSynced: () => {
      refreshPending();
    },
  });
  provider.attach();
  providers.set(documentId, provider);

  // Filet before_merge (A-010) : des changements locaux non envoyés et une mise à
  // jour distante arrive → instantané de l'état local, bandeau une fois (D-041).
  let snapshotTaken = false;
  let localChanges = options.localChanges;
  provider.on("synced", () => {
    localChanges = false;
  });
  const beforeTransaction = (transaction: Y.Transaction) => {
    if (transaction.origin !== provider || snapshotTaken || (provider.unsyncedChanges === 0 && !localChanges)) {
      return;
    }
    snapshotTaken = true;
    const before = Y.encodeStateAsUpdate(doc);
    void saveBeforeMerge(documentId, before).catch(() => undefined);
    transaction.doc.once("afterTransaction", (done: Y.Transaction) => {
      if (done.changed.size > 0) {
        showBannerOnce({ kind: "merged", documentId });
      }
    });
  };
  doc.on("beforeTransaction", beforeTransaction);

  return {
    provider,
    detach: () => {
      doc.off("beforeTransaction", beforeTransaction);
      provider.destroy();
      providers.delete(documentId);
      refreshPending();
    },
  };
}

/** Texte relié, synchronisé et sans envoi en attente. */
export function isLive(documentId: string): boolean {
  const provider = providers.get(documentId);
  return provider !== undefined && socket?.status === WebSocketStatus.Connected && provider.synced && provider.unsyncedChanges === 0;
}

/** Reconnexion manuelle (« Réessayer », D-044). */
export function retryNow(): void {
  const current = socket;
  if (current === null) {
    return;
  }
  void current.connect();
  for (const provider of providers.values()) {
    provider.forceSync();
  }
}

/** Déconnexion : on ferme la socket (la purge locale est faite par le stockage). */
export function closeSync(): void {
  for (const provider of providers.values()) {
    provider.destroy();
  }
  providers.clear();
  socket?.destroy();
  socket = null;
}
