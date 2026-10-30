import { emptyDocument, schema } from "@flaw/schema/src/index.ts";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { useEffect, useRef, useState } from "react";
import {
  absolutePositionToRelativePosition,
  prosemirrorToYXmlFragment,
  relativePositionToAbsolutePosition,
  undo,
  yXmlFragmentToProseMirrorRootNode,
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
import { editorKeymaps, insertChapter, pastePlugin } from "./commands.ts";
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
import { caretTop, focusPlugin, setFocusMode } from "./focus.ts";
import { searchPlugin } from "./search.ts";
import { SearchBar } from "./SearchBar.tsx";
import { ChapterJump } from "./ChapterJump.tsx";
import { EditorMenu, type EditorPanel } from "./EditorMenu.tsx";
import { Shortcuts } from "./Shortcuts.tsx";
import { History } from "./History.tsx";
import { ExportDialog } from "../export/ExportDialog.tsx";
import { keymap } from "prosemirror-keymap";
import { totalWords } from "./pagination/words.ts";
import { DailyGoal } from "../stats/DailyGoal.tsx";
import { recordWords } from "../stats/daily.ts";
import { MODE_TYPE, pageGeometry, surfaceOf, type Geometry } from "./pagination/geometry.ts";
import { paginationOf, paginationPlugin } from "./pagination/plugin.ts";
import { lastFolio, runningHead } from "./pagination/paginate.ts";
import { useEditorChrome } from "./useEditorChrome.ts";
import { useKeyboardClearance } from "./useKeyboardClearance.ts";
import { Logo } from "../shell/Logo.tsx";

export type EditorProps = { store: LocalStore; document: LocalDocument; trashed?: boolean };

const SAVE_DELAY_MS = 800;
const TOAST_MS = 4_000;
/** Lignes visibles dans la boîte du mode focus. */
const FOCUS_LINES = 4;

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
  const [endFolio, setEndFolio] = useState("1");
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
    const book = bookRef.current;
    const caret = caretTop(view);
    if (caret !== null && book) {
      // La ligne du curseur est la dernière de la boîte ; les précédentes restent lisibles au-dessus.
      // Correction relative à la translation en cours : insensible aux marges des blocs.
      const line = parseFloat(getComputedStyle(view.dom).lineHeight) || 0;
      const top = book.getBoundingClientRect().top + book.clientTop;
      // Valeur réelle (transition comprise), cohérente avec la position mesurée du curseur.
      const mounted = mount.current ? new DOMMatrixReadOnly(getComputedStyle(mount.current).transform) : null;
      const current = mounted?.m42 ?? 0;
      book.style.setProperty("--focus-offset", `${String(current + top + line * (FOCUS_LINES - 1) - caret)}px`);
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
      // Texte tout juste créé sur cet appareil : rien à attendre du serveur.
      const fresh = Date.now() - new Date(document.createdAt).getTime() < 120_000;
      if (fragment.length === 0 && navigator.onLine && !fresh) {
        await new Promise<void>((resolve) => {
          const done = () => {
            resolve();
          };
          attachment?.provider.on("synced", done);
          window.setTimeout(done, 1_500);
        });
      }
      if (!alive || mount.current === null) {
        return;
      }
      seed(opened, fragment, document.mode);
      // L'état part du contenu du Y.Doc : jamais d'un document vide qui l'écraserait.
      let initial;
      try {
        initial = yXmlFragmentToProseMirrorRootNode(fragment, schema);
        initial.check();
      } catch {
        initial = undefined;
      }
      const state = EditorState.create({
        schema,
        doc: initial,
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
            const folio = String(lastFolio(model));
            setEndFolio((previous) => (previous === folio ? previous : folio));
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

  // Page entière dès le départ : la dernière page va jusqu'à son pied, folio en bas.
  useEffect(() => {
    const book = bookRef.current;
    const content = mount.current;
    if (!book || !content || geometry.surface === "phone") {
      return;
    }
    const measure = () => {
      const gaps = book.querySelectorAll<HTMLElement>('.flaw-page-break:not([data-first="true"]) .flaw-gap');
      const last = gaps[gaps.length - 1];
      const top = last ? last.getBoundingClientRect().bottom - book.getBoundingClientRect().top : 0;
      book.style.setProperty("--book-last-top", `${String(Math.round(top))}px`);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    measure();
    return () => {
      observer.disconnect();
    };
  }, [geometry.surface, document.id]);

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
      {/* Barre minimale (WF-05) : retour, titre · chapitre · synchro, chapitre, focus, réglages, export, plus. */}
      <header className="editor-bar">
        <Logo className="editor-logo" />
        <div className="editor-center">
          <span className="editor-title">{document.title}</span>
          <span className="editor-subline">
            {head.chapter ? <span className="editor-head">{head.chapter}</span> : null}
            {head.chapter ? <span className="editor-sep" aria-hidden="true">·</span> : null}
            <SyncIndicator />
          </span>
        </div>
        <div className="editor-actions">
          {document.mode === "novel" ? (
            <button
              type="button"
              className="editor-chapter"
              title="Ctrl/⌘+Maj+Entrée"
              onClick={() => {
                const view = viewRef.current;
                if (view && insertChapter(view.state, view.dispatch)) {
                  view.focus();
                  setToast(true);
                  window.setTimeout(() => setToast(false), TOAST_MS);
                }
              }}
            >
              {t("chapter")}
            </button>
          ) : null}
          <button type="button" className="editor-icon" onClick={() => toggleFocus(true)} title={`${t("focus")} (Ctrl/⌘+Maj+F)`} aria-label={t("focus")}>
            F
          </button>
          <button type="button" className="editor-icon" onClick={() => setSettingsOpen(true)} title={t("settings")} aria-label={t("settings")}>
            Aa
          </button>
          <button type="button" className="editor-icon editor-export" onClick={() => setPanel("export")} title={t("menu_export")} aria-label={t("menu_export")}>
            ⇪
          </button>
          <EditorMenu
            mode={document.mode}
            onChapter={() => {
              const view = viewRef.current;
              if (view && insertChapter(view.state, view.dispatch)) {
                view.focus();
              }
            }}
            onSelect={(next) => setPanel(next)} available={["search", "chapters", "history", "export", "shortcuts"]} />
        </div>
      </header>
      {/* Compteur et objectif, coin bas droit, masquables (WF-05). */}
      <footer className="editor-footer">
        {prefs.showWordCount ? (
          <span className="editor-count">
            {document.mode === "screenplay" ? `${t("pages", { count: words.pages })} · ` : ""}
            {t("words", { count: words.words })}
          </span>
        ) : null}
        {prefs.showWordCount && prefs.showDailyGoal ? <span aria-hidden="true"> · </span> : null}
        <DailyGoal />
      </footer>
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
        <div className="flaw-page-end" aria-hidden="true">
          {endFolio}
        </div>
      </div>
      {panel === "search" && viewRef.current && !focusMode ? (
        <SearchBar view={viewRef.current} onClose={() => setPanel(null)} />
      ) : null}
      {panel === "chapters" && viewRef.current && !focusMode ? (
        <ChapterJump view={viewRef.current} onClose={() => setPanel(null)} />
      ) : null}
      {panel === "history" && !focusMode ? <History documentId={document.id} doc={ydoc} onClose={() => setPanel(null)} /> : null}
      {panel === "export" && viewRef.current && !focusMode ? (
        <ExportDialog
          id={document.id}
          onClose={() => setPanel(null)}
          input={() => ({
            title: document.title,
            mode: document.mode,
            pageFormat: document.pageFormat,
            lang: meta?.lang ?? "fr",
            fontFamily: fontFamily ?? undefined,
            baseFontSizePt: baseSize ?? undefined,
            doc: (viewRef.current?.state.doc.toJSON() ?? { type: "doc", content: [] }) as never,
          })}
        />
      ) : null}
      {panel === "shortcuts" ? <Shortcuts mode={document.mode} onClose={() => setPanel(null)} /> : null}
      {settingsOpen && !focusMode ? (
        <SettingsPanel text={textSettings()} onClose={() => setSettingsOpen(false)} />
      ) : null}
      {focusMode ? (
        <>
          <Logo className="focus-logo" />
          <button type="button" className="focus-exit" aria-label={t("exitFocus")} title={`${t("exitFocus")} (Échap)`} onClick={() => toggleFocus(false)}>
            ✕
          </button>
        </>
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
