import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { Editor } from "../editor/index.ts";
import { useTranslate } from "../i18n/i18n.ts";
import type { LocalDocument, LocalStore } from "../local-store/index.ts";
import { CreateFlow } from "./CreateFlow.tsx";
import { useRoute } from "./route.ts";
import { hideBootSplash } from "../shell/boot-splash.ts";
import { useDocuments, useLocalStore } from "./store-context.tsx";
import { TextList } from "./TextList.tsx";
import { Trash } from "./Trash.tsx";

export type TextView = (props: { store: LocalStore; document: LocalDocument; trashed?: boolean }) => ReactNode;

/** Durée minimale de l'écran de chargement (logo de index.html). */
const SPLASH_MS = 1_100;

/**
 * Bibliothèque : liste, création, ouverture d'un texte.
 * Au lancement, l'accueil (la liste) s'affiche après l'écran de chargement ;
 * dans un texte, le curseur revient où l'on s'était arrêté (AC-025).
 */
export function Library({ renderText = DefaultEditor }: { renderText?: TextView }) {
  const t = useTranslate("library");
  const state = useLocalStore();
  const store = state.status === "ready" ? state.store : null;
  const documents = useDocuments(store);
  const route = useRoute();
  // Texte ouvert puis placé dans la corbeille ailleurs : il reste affiché avec un bandeau (D-023).
  const lastOpened = useRef<LocalDocument | null>(null);
  const [minimum, setMinimum] = useState(false);
  const ready = store !== null && documents !== null;

  useEffect(() => {
    const timer = window.setTimeout(() => setMinimum(true), SPLASH_MS);
    return () => window.clearTimeout(timer);
  }, []);

  const shown = ready && minimum;
  const page = route.name === "text" ? `text:${route.id}` : route.name;

  // Chaque écran part du haut : le défilement de la liste ne doit pas déporter le texte ouvert.
  useLayoutEffect(() => {
    window.scrollTo(0, 0);
  }, [page]);

  useEffect(() => {
    if (shown || state.status === "error") {
      hideBootSplash();
    }
  }, [shown, state.status]);

  if (state.status === "error") {
    return <p role="alert">{t("storageError")}</p>;
  }
  if (!store || documents === null || !shown) {
    // Sous le logo de chargement : rien d'autre ne s'affiche.
    return <span className="visually-hidden" role="status">{t("loading")}</span>;
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
