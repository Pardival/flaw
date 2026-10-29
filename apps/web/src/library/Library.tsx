import { useEffect, useRef, useState, type ReactNode } from "react";

import { Editor } from "../editor/index.ts";
import { useTranslate } from "../i18n/i18n.ts";
import type { LocalDocument, LocalStore } from "../local-store/index.ts";
import { CreateFlow } from "./CreateFlow.tsx";
import { navigate, useRoute } from "./route.ts";
import { useDocuments, useLocalStore } from "./store-context.tsx";
import { TextList } from "./TextList.tsx";
import { Trash } from "./Trash.tsx";

export type TextView = (props: { store: LocalStore; document: LocalDocument; trashed?: boolean }) => ReactNode;

/**
 * Bibliothèque : liste, création, ouverture d'un texte.
 * Après connexion, le dernier texte se rouvre une fois (AC-025) ; la liste reste à un geste (retour).
 */
export function Library({ renderText = DefaultEditor }: { renderText?: TextView }) {
  const t = useTranslate("library");
  const state = useLocalStore();
  const store = state.status === "ready" ? state.store : null;
  const documents = useDocuments(store);
  const route = useRoute();
  const [reopened, setReopened] = useState(false);
  // Texte ouvert puis placé dans la corbeille ailleurs : il reste affiché avec un bandeau (D-023).
  const lastOpened = useRef<LocalDocument | null>(null);
  const reopening = useRef(false);

  useEffect(() => {
    if (!store || reopening.current) {
      return;
    }
    reopening.current = true;
    if (route.name !== "list") {
      setReopened(true);
      return;
    }
    store.reopenLast().then(
      (last) => {
        if (last) {
          // La liste reste dans l'historique : un retour y ramène.
          navigate({ name: "text", id: last.id });
        }
        setReopened(true);
      },
      () => {
        setReopened(true);
      },
    );
  }, [store, route.name]);

  if (state.status === "error") {
    return <p role="alert">{t("storageError")}</p>;
  }
  if (!store || documents === null || !reopened) {
    return <p className="library-loading">{t("loading")}</p>;
  }

  if (route.name === "create") {
    return <CreateFlow store={store} />;
  }
  if (route.name === "trash") {
    return <Trash store={store} />;
  }
  if (route.name === "text") {
    const current = documents.find((doc) => doc.id === route.id);
    if (current) {
      lastOpened.current = current;
      return <>{renderText({ store, document: current })}</>;
    }
    if (lastOpened.current?.id === route.id) {
      return <>{renderText({ store, document: lastOpened.current, trashed: true })}</>;
    }
    return <TextList store={store} documents={documents} />;
  }
  return <TextList store={store} documents={documents} />;
}

function DefaultEditor({ store, document, trashed }: { store: LocalStore; document: LocalDocument; trashed?: boolean }) {
  return <Editor key={document.id} store={store} document={document} trashed={trashed} />;
}
