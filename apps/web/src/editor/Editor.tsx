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
import { navigate, takePendingPanel } from "../library/route.ts";
import { SyncBanners, SyncIndicator } from "../shell/status/SyncStatus.tsx";
import { attachDocument, type Attachment } from "../sync-client/connection.ts";
import { dismissBanner, readFlags, showBannerOnce, updateSync, useSyncStatus } from "../sync-client/status.ts";
import { editorKeymaps, pastePlugin } from "./commands.ts";
import { ElementBar } from "./modes/script/ElementBar.tsx";
import { SelectionMenu, menuPosition, type MenuPosition } from "./SelectionMenu.tsx";
import { frenchTypographyOn, useMeta, writeMeta } from "./meta.ts";
import { SettingsPanel, fontsFor, type TextSettings } from "../settings/SettingsPanel.tsx";
import { usePreferences } from "../settings/preferences.tsx";
import { saveBeforeMerge } from "../sync-client/before-merge.ts";
import { convertSpacesForMode } from "./typography.ts";
import { FORMATS_BY_MODE, defaultFormat } from "../library/formats-by-mode.ts";
import { changeSize } from "./size.ts";
import { typographyPlugin } from "./typography.ts";
import { caretLineOffset, focusPlugin, setFocusMode } from "./focus.ts";
import { searchPlugin } from "./search.ts";
import { SearchBar } from "./SearchBar.tsx";
import { ChapterJump } from "./ChapterJump.tsx";
import { EditorMenu, type EditorPanel } from "./EditorMenu.tsx";
import { Shortcuts } from "./Shortcuts.tsx";
import { History } from "./History.tsx";
import { keymap } from "prosemirror-keymap";
import { totalWords } from "./pagination/words.ts";
import { DailyGoal } from "../stats/DailyGoal.tsx";
import { recordWords } from "../stats/daily.ts";
import { MODE_TYPE, pageGeometry, surfaceOf, type Geometry } from "./pagination/geometry.ts";
import { paginationOf, paginationPlugin } from "./pagination/plugin.ts";
import { runningHead } from "./pagination/paginate.ts";
import { useEditorChrome } from "./useEditorChrome.ts";
import { useKeyboardClearance } from "./useKeyboardClearance.ts";

export type EditorProps = { store: LocalStore; document: LocalDocument; trashed?: boolean };

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
export function Editor({ store, document, trashed = false }: EditorProps) {
  const t = useTranslate("editor");
  const mount = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [ready, setReady] = useState(false);
  const [head, setHead] = useState<{ chapter: string; folio: string }>({ chapter: "", folio: "" });
  const [toast, setToast] = useState(false);
  const [element, setElement] = useState("");
  const [menu, setMenu] = useState<MenuPosition>(null);
  const [ydoc, setYdoc] = useState<Y.Doc | null>(null);
  const [words, setWords] = useState<{ words: number; pages: number }>({ words: document.wordCount, pages: 1 });
  const { prefs } = usePreferences();
  const generalFrench = prefs.frenchTypographyDefault;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [panel, setPanel] = useState<EditorPanel | null>(() => takePendingPanel());
  const meta = useMeta(ydoc);
  const typographyRef = useRef({ on: true, mode: document.mode });
  typographyRef.current = { on: meta === null ? generalFrench : frenchTypographyOn(meta, generalFrench), mode: document.mode };
  const baseSizeRef = useRef(MODE_TYPE[document.mode].sizePt);
  baseSizeRef.current = meta?.baseFontSizePt ?? document.baseFontSizePt ?? MODE_TYPE[document.mode].sizePt;
  const [width, setWidth] = useState(() => window.innerWidth);
  const geometry = geometryFor(document, width);
  const surfaceKey = `${geometry.surface}:${document.pageFormat}`;
  const [focused, setFocused] = useState(false);
  const [focusMode, setFocusModeState] = useState(false);
  const [focusHint, setFocusHint] = useState(false);
  const focusRef = useRef(false);
  focusRef.current = focusMode;
  const bookRef = useRef<HTMLDivElement>(null);
  const { hidden: typingHidden, onTyping } = useEditorChrome();
  // Page blanche : aucune interface tant que la page a le focus (AC-020, D-032).
  const hidden = typingHidden || (document.mode === "blank" && focused);


  const sync = useSyncStatus();
  const readOnly = sync.state === "update-required";

  useEffect(() => {
    if (trashed) {
      showBannerOnce({ kind: "trashed-elsewhere", documentId: document.id });
    }
  }, [trashed, document.id]);

  useEffect(() => {
    viewRef.current?.setProps({ editable: () => !readOnly });
  }, [readOnly]);
  useKeyboardClearance(viewRef);

  /** En focus, la page ne laisse voir que la ligne du curseur. */
  const alignFocusLine = (view: EditorView) => {
    const offset = caretLineOffset(view);
    if (offset !== null && bookRef.current) {
      bookRef.current.style.setProperty("--focus-offset", `${String(-offset)}px`);
    }
  };

  const toggleFocus = (active: boolean) => {
    const view = viewRef.current;
    if (!view) {
      return;
    }
    setFocusMode(view, active);
    setFocusModeState(active);
    if (active) {
      void store.getPreference("focusHintSeen").then((seen) => {
        if (seen !== "true") {
          setFocusHint(true);
          window.setTimeout(() => {
            setFocusHint(false);
          }, 2_000);
          void store.setPreference("focusHintSeen", "true");
        }
      });
      requestAnimationFrame(() => {
        alignFocusLine(view);
        view.focus();
      });
    } else {
      requestAnimationFrame(() => {
        view.dispatch(view.state.tr.scrollIntoView());
        view.focus();
      });
    }
  };

  // Ctrl/⌘+Maj+F entre et sort ; Échap sort (AC-034, AC-039).
  // Ctrl/⌘+F : recherche interne (dans l'éditeur seulement) ; Ctrl+Alt+G : aller au chapitre.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && (event.key === "f" || event.key === "F")) {
        event.preventDefault();
        setPanel("search");
        return;
      }
      const altGraph = event.getModifierState("AltGraph") && event.key !== "g" && event.key !== "G" && event.key.length === 1;
      if ((event.ctrlKey || event.metaKey) && event.altKey && !altGraph && (event.code === "KeyG") && document.mode === "novel") {
        event.preventDefault();
        setPanel("chapters");
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === "f" || event.key === "F")) {
        event.preventDefault();
        toggleFocus(!focusRef.current);
      } else if (event.key === "Escape" && focusRef.current) {
        event.preventDefault();
        toggleFocus(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  });

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
    let attachment: Attachment | null = null;
    let timer: number | undefined;
    let toastTimer: number | undefined;
    let lastTotal: number | null = null;
    const id = document.id;

    const save = () => {
      updateSync({ saving: false });
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

    const onUpdate = (_update: Uint8Array, origin: unknown) => {
      if (attachment !== null && origin === attachment.provider) {
        // Modification venue du serveur : déjà synchronisée, on met juste à jour la liste.
        timer ??= window.setTimeout(save, SAVE_DELAY_MS);
        return;
      }
      updateSync({ saving: true });
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
      setYdoc(opened);
      const fragment = opened.getXmlFragment(PROSEMIRROR_FRAGMENT);
      const pending = await store.pendingOperations().catch(() => []);
      if (!alive) {
        return;
      }
      attachment = attachDocument(id, opened, {
        localChanges: pending.some((operation) => operation.documentId === id && operation.path.endsWith("/sync")),
      });
      // Contenu initial seulement si ni l'appareil ni le serveur n'ont de contenu.
      if (fragment.length === 0 && navigator.onLine) {
        await new Promise<void>((resolve) => {
          const done = () => {
            resolve();
          };
          attachment?.provider.on("synced", done);
          window.setTimeout(done, 3_000);
        });
      }
      if (!alive || mount.current === null) {
        return;
      }
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
          focusPlugin(),
          searchPlugin(),
          pastePlugin(),
          typographyPlugin({ enabled: () => typographyRef.current.on, mode: () => typographyRef.current.mode }),
          keymap({
            "Mod-Shift-.": changeSize(0.5, () => baseSizeRef.current),
            "Mod-Shift-,": changeSize(-0.5, () => baseSizeRef.current),
          }),
          paginationPlugin(geometry),
        ],
      });
      view = new EditorView(mount.current, {
        state,
        editable: () => !readFlags().updateRequired,
        markViews: {
          font_size: (mark) => {
            const span = window.document.createElement("span");
            span.dataset.fontSize = String(mark.attrs.pt);
            span.style.fontSize = `calc(${String(mark.attrs.pt)}pt * var(--book-scale))`;
            return { dom: span };
          },
        },
        handleDOMEvents: {
          focus: () => {
            setFocused(true);
            return false;
          },
          blur: () => {
            setFocused(false);
            return false;
          },
        },
        attributes: {
          class: "book-text",
          "data-mode": document.mode,
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
          if (focusRef.current) {
            alignFocusLine(current);
          }
          const name = current.state.selection.$from.parent.type.name;
          setElement((previous) => (previous === name ? previous : name));
          setMenu(menuPosition(current));
          const model = paginationOf(current.state);
          if (model !== undefined) {
            const total = totalWords(model.counts);
            const pages = model.chapters.reduce(
              (sum, chapter) =>
                sum + (chapter.status === "measured" ? chapter.pages.length : Math.max(1, Math.ceil(chapter.words / model.geometry.wordsPerPage))),
              0,
            );
            setWords((previous) => (previous.words === total && previous.pages === pages ? previous : { words: total, pages }));
            // Mots nets du jour : seulement les changements faits sur cet appareil.
            if (lastTotal !== null && tr.docChanged && !tr.getMeta(ySyncPluginKey)) {
              recordWords(total - lastTotal);
            }
            lastTotal = total;
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
      attachment?.detach();
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

  const textSettings = (): TextSettings => ({
    document,
    lang: meta?.lang ?? "fr",
    frenchTypography: meta?.frenchTypography ?? null,
    fontFamily: meta?.fontFamily ?? document.fontFamily ?? fontsFor(document.mode)[0] ?? "",
    baseFontSizePt: baseSizeRef.current,
    onRename: (title) => {
      void store.renameDocument(document.id, title).catch(() => undefined);
    },
    onFormat: (pageFormat) => {
      void store.updateDocument(document.id, { pageFormat }).catch(() => undefined);
    },
    onFont: (font) => {
      if (ydoc) {
        writeMeta(ydoc, { fontFamily: font });
      }
      void store.updateDocument(document.id, { fontFamily: font }).catch(() => undefined);
    },
    onSize: (size) => {
      if (ydoc) {
        writeMeta(ydoc, { baseFontSizePt: size });
      }
      void store.updateDocument(document.id, { baseFontSizePt: size }).catch(() => undefined);
    },
    onLang: (lang) => {
      if (ydoc) {
        writeMeta(ydoc, { lang });
      }
    },
    onFrenchTypography: (value) => {
      if (ydoc) {
        writeMeta(ydoc, { frenchTypography: value });
      }
    },
    onMode: (mode) => {
      const view = viewRef.current;
      // Instantané avant le changement : la version d'avant reste dans l'historique.
      if (ydoc) {
        void saveBeforeMerge(document.id, Y.encodeStateAsUpdate(ydoc)).catch(() => undefined);
        writeMeta(ydoc, { fontFamily: null });
      }
      if (view && (mode === "screenplay") !== (document.mode === "screenplay")) {
        view.dispatch(convertSpacesForMode(view.state.tr, mode === "screenplay"));
      }
      const pageFormat = FORMATS_BY_MODE[mode].includes(document.pageFormat) ? undefined : defaultFormat(mode);
      void store
        .updateDocument(document.id, { mode, fontFamily: fontsFor(mode)[0] ?? "", ...(pageFormat ? { pageFormat } : {}) })
        .catch(() => undefined);
      setSettingsOpen(false);
    },
  });

  const type = MODE_TYPE[document.mode];
  const fontFamily =
    document.mode === "screenplay" ? null : (meta?.fontFamily ?? document.fontFamily ?? null);
  const baseSize = document.mode === "screenplay" ? null : (meta?.baseFontSizePt ?? document.baseFontSizePt ?? null);
  const style = {
    ...(fontFamily !== null ? { fontFamily: `"${fontFamily.replace(/"/gu, "")}", var(--police-roman)` } : {}),
    ...(baseSize !== null ? { "--book-text-size": `calc(${String(baseSize)}pt * var(--book-scale))` } : {}),
    "--book-scale": String(type.scale),
    "--book-width": `${String(geometry.pageWidthPx)}px`,
    "--book-height": `${String(geometry.pageHeightPx)}px`,
    "--book-margin-top": `${String(geometry.marginsPx.top)}px`,
    "--book-margin-right": `${String(geometry.marginsPx.right)}px`,
    "--book-margin-bottom": `${String(geometry.marginsPx.bottom)}px`,
    "--book-margin-left": `${String(geometry.marginsPx.left)}px`,
  } as React.CSSProperties;

  return (
    <div
      className="editor-desk"
      data-chrome-hidden={hidden || focusMode ? "true" : "false"}
      data-focus={focusMode ? "true" : "false"}
      onKeyDown={onTyping}
    >
      <header className="editor-bar">
        <button type="button" className="editor-back" onClick={() => navigate({ name: "list" })} aria-label={t("backToList")}>
          ←
        </button>
        <span className="editor-title">{document.title}</span>
        <span className="editor-head" aria-live="off">
          {head.chapter}
        </span>
        <EditorMenu mode={document.mode} onSelect={(next) => setPanel(next)} available={["search", "chapters", "history", "shortcuts"]} />
        <button type="button" className="editor-focus" onClick={() => setSettingsOpen(true)} aria-label={t("settings")}>
          Aa
        </button>
        <button type="button" className="editor-focus" onClick={() => toggleFocus(true)} title="Ctrl/⌘+Maj+F">
          {t("focus")}
        </button>
        <span className="editor-count" aria-live="off">
          {prefs.showWordCount ? (
            <>
              {document.mode === "screenplay" ? `${t("pages", { count: words.pages })} · ` : ""}
              {t("words", { count: words.words })}
            </>
          ) : null}
        </span>
        <DailyGoal />
        <SyncIndicator />
      </header>
      <SyncBanners
        documentId={document.id}
        actions={{
          onRestore: (documentId) => {
            void store.restoreDocument(documentId).catch(() => undefined);
            dismissBanner({ kind: "trashed-elsewhere", documentId });
          },
          onBack: () => {
            navigate({ name: "list" });
          },
          onHistory: () => {
            setPanel("history");
          },
        }}
      />
      <div
        ref={bookRef}
        className="book"
        data-mode={document.mode}
        data-format={document.pageFormat}
        data-surface={geometry.surface}
        data-ready={ready ? "true" : "false"}
        lang={meta?.lang ?? "fr"}
        spellCheck={prefs.spellcheck}
        style={style}
      >
        <div ref={mount} className="book-mount" />
      </div>
      {panel === "search" && viewRef.current && !focusMode ? (
        <SearchBar view={viewRef.current} onClose={() => setPanel(null)} />
      ) : null}
      {panel === "chapters" && viewRef.current && !focusMode ? (
        <ChapterJump view={viewRef.current} onClose={() => setPanel(null)} />
      ) : null}
      {panel === "history" && !focusMode ? <History documentId={document.id} doc={ydoc} onClose={() => setPanel(null)} /> : null}
      {panel === "shortcuts" ? <Shortcuts mode={document.mode} onClose={() => setPanel(null)} /> : null}
      {settingsOpen && !focusMode ? (
        <SettingsPanel text={textSettings()} onClose={() => setSettingsOpen(false)} />
      ) : null}
      {focusMode ? (
        <button type="button" className="focus-exit" aria-label={t("exitFocus")} onClick={() => toggleFocus(false)}>
          ✕
        </button>
      ) : null}
      {focusHint ? (
        <div className="focus-hint" role="status">
          {window.innerWidth < 600 ? t("focusHintPhone") : t("focusHint")}
        </div>
      ) : null}
      <SelectionMenu view={viewRef.current} mode={document.mode} position={focusMode ? null : menu} baseSize={() => baseSizeRef.current} />
      {document.mode === "screenplay" ? (
        <ElementBar view={viewRef.current} current={element} discreet={focusMode} />
      ) : null}
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
