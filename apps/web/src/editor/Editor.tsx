import { emptyDocument, schema } from "@flaw/schema/src/index.ts";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { useEffect, useRef, useState } from "react";
import {
  absolutePositionToRelativePosition,
  prosemirrorToYXmlFragment,
  relativePositionToAbsolutePosition,
  undo,
  ySyncPlugin,
  ySyncPluginKey,
  yUndoPlugin,
} from "y-prosemirror";
import * as Y from "yjs";

import { useTranslate } from "../i18n/i18n.ts";
import { PROSEMIRROR_FRAGMENT, type LocalDocument, type LocalStore } from "../local-store/index.ts";
import { navigate } from "../library/route.ts";
import { editorKeymaps, pastePlugin } from "./commands.ts";
import { MODE_TYPE, pageGeometry, surfaceOf, type Geometry } from "./pagination/geometry.ts";
import { paginationOf, paginationPlugin } from "./pagination/plugin.ts";
import { runningHead } from "./pagination/paginate.ts";
import { useEditorChrome } from "./useEditorChrome.ts";
import { useKeyboardClearance } from "./useKeyboardClearance.ts";

export type EditorProps = { store: LocalStore; document: LocalDocument };

const SAVE_DELAY_MS = 800;
const TOAST_MS = 4_000;

/** Contenu initial du mode, une seule fois, quand le fragment est vide. */
function seed(doc: Y.Doc, fragment: Y.XmlFragment, mode: LocalDocument["mode"]): void {
  if (fragment.length > 0) {
    return;
  }
  doc.transact(() => {
    prosemirrorToYXmlFragment(emptyDocument(mode), fragment);
  });
}

function geometryFor(document: LocalDocument, width: number): Geometry {
  const surface = surfaceOf(width);
  return pageGeometry(document.mode, document.pageFormat, surface, Math.min(width, 640) - 32);
}

/**
 * Éditeur au format livre (T-022, D-026) : un seul ProseMirror lié au Y.Doc local,
 * pages par décorations (niveau 1), en-tête du chapitre courant, folios.
 */
export function Editor({ store, document }: EditorProps) {
  const t = useTranslate("editor");
  const mount = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [ready, setReady] = useState(false);
  const [head, setHead] = useState<{ chapter: string; folio: string }>({ chapter: "", folio: "" });
  const [toast, setToast] = useState(false);
  const [width, setWidth] = useState(() => window.innerWidth);
  const geometry = geometryFor(document, width);
  const surfaceKey = `${geometry.surface}:${document.pageFormat}`;
  const { hidden, onTyping } = useEditorChrome();
  useKeyboardClearance(viewRef);

  useEffect(() => {
    const onResize = () => {
      setWidth(window.innerWidth);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    let view: EditorView | null = null;
    let doc: Y.Doc | null = null;
    let timer: number | undefined;
    let toastTimer: number | undefined;
    const id = document.id;

    const save = () => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
      void store.captureEdits(id).catch(() => undefined);
      const current = view;
      if (current !== null) {
        const binding = ySyncPluginKey.getState(current.state)?.binding as
          | { type: Y.XmlFragment; mapping: Map<Y.AbstractType<unknown>, unknown> }
          | undefined;
        if (binding) {
          const relative = absolutePositionToRelativePosition(
            current.state.selection.head,
            binding.type,
            binding.mapping as never,
          );
          void store.saveCursor(id, Y.encodeRelativePosition(relative)).catch(() => undefined);
        }
      }
    };

    const onUpdate = () => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
      timer = window.setTimeout(save, SAVE_DELAY_MS);
    };

    void (async () => {
      const opened = await store.openDocument(id);
      if (!alive || mount.current === null) {
        return;
      }
      doc = opened;
      const fragment = opened.getXmlFragment(PROSEMIRROR_FRAGMENT);
      seed(opened, fragment, document.mode);
      const state = EditorState.create({
        schema,
        plugins: [
          ySyncPlugin(fragment),
          yUndoPlugin(),
          ...editorKeymaps(document.mode, {
            onChapter: () => {
              setToast(true);
              window.clearTimeout(toastTimer);
              toastTimer = window.setTimeout(() => {
                setToast(false);
              }, TOAST_MS);
            },
          }),
          pastePlugin(),
          paginationPlugin(geometry),
        ],
      });
      view = new EditorView(mount.current, {
        state,
        attributes: {
          class: "book-text",
          "data-mode": document.mode,
          spellcheck: "true",
          lang: "fr",
          "aria-label": t("textArea"),
          "aria-multiline": "true",
          role: "textbox",
        },
        dispatchTransaction(tr) {
          const current = view;
          if (current === null) {
            return;
          }
          current.updateState(current.state.apply(tr));
          const model = paginationOf(current.state);
          if (model !== undefined) {
            const running = runningHead(model, current.state.selection.from);
            setHead((previous) =>
              previous.chapter === running.chapterTitle && previous.folio === String(running.folio)
                ? previous
                : { chapter: running.chapterTitle, folio: String(running.folio) },
            );
          }
        },
      });
      viewRef.current = view;
      opened.on("update", onUpdate);

      // AC-025 : retour à l'endroit où l'on s'était arrêté.
      const saved = await store.loadCursor(id).catch(() => null);
      if (alive && view !== null) {
        const binding = ySyncPluginKey.getState(view.state)?.binding as
          | { type: Y.XmlFragment; mapping: Map<Y.AbstractType<unknown>, unknown> }
          | undefined;
        let pos: number | null = null;
        if (saved !== null && binding) {
          try {
            pos = relativePositionToAbsolutePosition(opened, binding.type, Y.decodeRelativePosition(saved), binding.mapping as never);
          } catch {
            pos = null;
          }
        }
        const target = Math.max(1, Math.min(pos ?? 1, view.state.doc.content.size - 1));
        try {
          view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(target))).scrollIntoView());
        } catch {
          // Position hors texte : le curseur reste au début.
        }
        view.focus();
        setReady(true);
      }
    })();

    const onHide = () => {
      if (window.document.visibilityState === "hidden") {
        save();
      }
    };
    window.document.addEventListener("visibilitychange", onHide);

    return () => {
      alive = false;
      window.document.removeEventListener("visibilitychange", onHide);
      window.clearTimeout(toastTimer);
      doc?.off("update", onUpdate);
      save();
      view?.destroy();
      viewRef.current = null;
      view = null;
    };
    // La géométrie change avec la surface ou le format : on remonte l'éditeur.
  }, [store, document.id, document.mode, surfaceKey]);

  // Revenir à la liste : Alt+← / ⌘+[ (l'éditeur est une route, le retour du navigateur marche aussi).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.altKey && event.key === "ArrowLeft") || (event.metaKey && event.key === "[")) {
        event.preventDefault();
        navigate({ name: "list" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const type = MODE_TYPE[document.mode];
  const style = {
    "--book-scale": String(type.scale),
    "--book-width": `${String(geometry.pageWidthPx)}px`,
    "--book-height": `${String(geometry.pageHeightPx)}px`,
    "--book-margin-top": `${String(geometry.marginsPx.top)}px`,
    "--book-margin-right": `${String(geometry.marginsPx.right)}px`,
    "--book-margin-bottom": `${String(geometry.marginsPx.bottom)}px`,
    "--book-margin-left": `${String(geometry.marginsPx.left)}px`,
  } as React.CSSProperties;

  return (
    <div className="editor-desk" data-chrome-hidden={hidden ? "true" : "false"} onKeyDown={onTyping}>
      <header className="editor-bar">
        <button type="button" className="editor-back" onClick={() => navigate({ name: "list" })} aria-label={t("backToList")}>
          ←
        </button>
        <span className="editor-title">{document.title}</span>
        <span className="editor-head" aria-live="off">
          {head.chapter}
        </span>
      </header>
      <div
        className="book"
        data-mode={document.mode}
        data-format={document.pageFormat}
        data-surface={geometry.surface}
        data-ready={ready ? "true" : "false"}
        style={style}
      >
        <div ref={mount} className="book-mount" />
      </div>
      {toast ? (
        <div className="toast" role="status">
          <span>{t("chapterInserted")}</span>
          <button
            type="button"
            onClick={() => {
              const view = viewRef.current;
              if (view) {
                undo(view.state);
                view.focus();
              }
              setToast(false);
            }}
          >
            {t("undo")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
