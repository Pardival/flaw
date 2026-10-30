import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { openLocalStore, type LocalDocument, type LocalStore } from "../local-store/index.ts";
import { LOCAL_ONLY } from "../platform/target.ts";
import { isLive } from "../sync-client/connection.ts";
import { makeSender, pullRemoteList } from "../sync-client/rest.ts";
import { updateSync } from "../sync-client/status.ts";

type StoreState = { status: "loading" } | { status: "ready"; store: LocalStore } | { status: "error" };

const StoreContext = createContext<StoreState>({ status: "loading" });

/** Ouvre le stockage local une fois pour l'app et vide la file REST au retour du réseau (A-004). */
export function LocalStoreProvider({ children, store: injected }: { children: ReactNode; store?: LocalStore }) {
  const [state, setState] = useState<StoreState>(
    injected ? { status: "ready", store: injected } : { status: "loading" },
  );

  useEffect(() => {
    if (injected) {
      return;
    }
    let closed = false;
    let opened: LocalStore | null = null;
    openLocalStore(LOCAL_ONLY ? { localOnly: true } : { send: makeSender(() => opened) }).then(
      (store) => {
        if (closed) {
          void store.close();
          return;
        }
        opened = store;
        setState({ status: "ready", store });
      },
      () => {
        if (!closed) {
          setState({ status: "error" });
        }
      },
    );
    return () => {
      closed = true;
      void opened?.close();
    };
  }, [injected]);

  useEffect(() => {
    if (state.status !== "ready") {
      return;
    }
    const { store } = state;
    if (LOCAL_ONLY) {
      // Rien à envoyer : on surveille seulement un stockage plein.
      const check = () => {
        updateSync({ storageFull: store.isMemoryOnly() });
      };
      check();
      return store.subscribe(check);
    }
    const send = makeSender(() => store);
    let running = false;
    const count = () => {
      updateSync({ storageFull: store.isMemoryOnly() });
      void store.pendingOperations().then(
        (operations) => {
          // Le contenu passe par le WebSocket ; la file compte les métadonnées et le repli hors WSS.
          updateSync({ queued: operations.filter((operation) => !isLive(operation.documentId) || !operation.path.endsWith("/sync")).length });
        },
        () => undefined,
      );
    };
    const flush = () => {
      if (running || !navigator.onLine) {
        return;
      }
      running = true;
      store
        .flush(send)
        .then(() => pullRemoteList(store))
        .catch(() => undefined)
        .finally(() => {
          running = false;
          count();
        });
    };
    flush();
    const unsubscribe = store.subscribe(count);
    window.addEventListener("online", flush);
    const timer = window.setInterval(flush, 30_000);
    return () => {
      unsubscribe();
      window.removeEventListener("online", flush);
      window.clearInterval(timer);
    };
  }, [state]);

  return <StoreContext.Provider value={state}>{children}</StoreContext.Provider>;
}

export function useLocalStore(): StoreState {
  return useContext(StoreContext);
}

/** Liste active, triée par dernière modification, tenue à jour par les événements du stockage. */
export function useDocuments(store: LocalStore | null): LocalDocument[] | null {
  const [documents, setDocuments] = useState<LocalDocument[] | null>(null);
  useEffect(() => {
    if (!store) {
      return;
    }
    let alive = true;
    const load = () => {
      store.listDocuments().then(
        (list) => {
          if (alive) {
            setDocuments(list);
          }
        },
        () => undefined,
      );
    };
    load();
    const unsubscribe = store.subscribe((event) => {
      if (event.kind !== "preferences") {
        load();
      }
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [store]);
  return documents;
}
