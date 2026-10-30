import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Logo } from "../shell/Logo.tsx";

import { useTranslate } from "../i18n/i18n.ts";
import { DOCUMENT_MODES, type LocalDocument, type LocalStore } from "../local-store/index.ts";
import { MODE_FONT } from "./formats-by-mode.ts";
import { SyncBanners, SyncIndicator } from "../shell/status/SyncStatus.tsx";
import { SettingsPanel } from "../settings/SettingsPanel.tsx";
import { DailyGoal } from "../stats/DailyGoal.tsx";
import { ImportFlow } from "../import/ImportFlow.tsx";
import { navigate, openTextWith } from "./route.ts";
import { createWithMode } from "./CreateFlow.tsx";
import { ModeSketch } from "./ModeSketch.tsx";

const DATE = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric" });
const TIME = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });

function shortDate(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  return date.toDateString() === today.toDateString() ? TIME.format(date) : DATE.format(date);
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

/** Liste unique triée par dernière modification (D-009, AC-023), menu ⋯ (D-011), état vide (D-012). */
export function TextList({ store, documents }: { store: LocalStore; documents: LocalDocument[] }) {
  const t = useTranslate("library");
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [trashedToast, setTrashedToast] = useState<LocalDocument | null>(null);
  const [importing, setImporting] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (trashedToast === null) {
      return;
    }
    const timer = window.setTimeout(() => {
      setTrashedToast(null);
    }, 4_000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [trashedToast]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [trashing, setTrashing] = useState<{ doc: LocalDocument; confirmationId: string } | null>(null);
  const rows = useRef<(HTMLAnchorElement | null)[]>([]);

  // Raccourcis de la liste (aucun champ actif) : N nouveau texte, ↑ ↓ déplacement.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target) || trashing || renaming) {
        return;
      }
      if (event.key === "n" || event.key === "N") {
        event.preventDefault();
        navigate({ name: "create" });
      } else if (event.key === "i" || event.key === "I") {
        event.preventDefault();
        picker.current?.click();
      } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && rows.current.length > 0) {
        const index = rows.current.findIndex((row) => row === document.activeElement);
        const step = event.key === "ArrowDown" ? 1 : -1;
        const next = index === -1 ? 0 : Math.min(rows.current.length - 1, Math.max(0, index + step));
        event.preventDefault();
        rows.current[next]?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [trashing, renaming]);

  const askTrash = async (doc: LocalDocument) => {
    setMenuFor(null);
    const confirmation = await store.requestTrash(doc.id);
    setTrashing({ doc, confirmationId: confirmation.confirmationId });
  };

  const header = (
    <>
    <SyncBanners />
    <header className="library-bar">
      <Logo />
      <span className="library-bar-spacer" />
      <DailyGoal />
      <button type="button" className="library-import" onClick={() => picker.current?.click()} title="I">
        {t("importAction")}
      </button>
      <input
        ref={picker}
        type="file"
        hidden
        accept=".docx,.md,.markdown,.txt"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) {
            setImporting(file);
          }
        }}
      />
      <SyncIndicator />
      {/* Réglages : discrets, en bas à droite (à gauche sur téléphone, le bouton Écrire y est). */}
      <button type="button" className="library-settings" aria-label={t("settings")} title={t("settings")} onClick={() => setSettingsOpen(true)}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
      <button type="button" className="button-primary" onClick={() => navigate({ name: "create" })}>
        {t("newText")}
      </button>
    </header>
    {importing ? <ImportFlow store={store} file={importing} onClose={() => setImporting(null)} /> : null}
    {settingsOpen ? (
      <SettingsPanel onClose={() => setSettingsOpen(false)} onTrash={() => navigate({ name: "trash" })} />
    ) : null}
    </>
  );

  const dropProps = {
    "data-dragging": dragging ? "true" : "false",
    onDragOver: (event: React.DragEvent) => {
      if (event.dataTransfer.types.includes("Files")) {
        event.preventDefault();
        setDragging(true);
      }
    },
    onDragLeave: () => setDragging(false),
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      setDragging(false);
      // Un seul fichier à la fois (AC-082).
      const file = event.dataTransfer.files[0];
      if (file) {
        setImporting(file);
      }
    },
  };

  const [loadingSamples, setLoadingSamples] = useState(false);

  if (documents.length === 0) {
    return (
      <div className="library" {...dropProps}>
        {header}
        <section className="library-welcome" aria-labelledby="welcome-title">
          <div className="welcome-art" aria-hidden="true">
            <span className="welcome-sheet welcome-sheet-back" />
            <span className="welcome-sheet welcome-sheet-mid" />
            <span className="welcome-sheet welcome-sheet-front">
              <span className="welcome-line" />
              <span className="welcome-line" />
              <span className="welcome-line" />
              <span className="welcome-line welcome-line-short" />
              <span className="welcome-caret" />
            </span>
          </div>
          <h1 id="welcome-title">{t("welcomeTitle")}</h1>
          <p className="welcome-lead">{t("welcomeLead")}</p>
          <ul className="welcome-modes">
            {DOCUMENT_MODES.map((mode) => (
              <li key={mode}>
                <button type="button" className="welcome-mode" data-mode={mode} onClick={() => createWithMode(mode)}>
                  <span className="welcome-mode-page">
                    <ModeSketch mode={mode} />
                  </span>
                  <span className="welcome-mode-name">{t(`mode_${mode}`)}</span>
                  <span className="welcome-mode-hint">{t(`modeHint_${mode}`)}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="welcome-import">
            <div className="welcome-import-actions">
              <button type="button" onClick={() => picker.current?.click()}>
                {t("welcomeImport")}
              </button>
              <button
                type="button"
                className="welcome-samples"
                disabled={loadingSamples}
                onClick={() => {
                  setLoadingSamples(true);
                  void import("./samples/index.ts")
                    .then(({ loadSamples }) => loadSamples(store))
                    .catch(() => undefined)
                    .finally(() => setLoadingSamples(false));
                }}
              >
                {loadingSamples ? t("welcomeSamplesBusy") : t("welcomeSamples")}
              </button>
            </div>
            <small>{t("welcomeImportHint")}</small>
          </div>
          <aside className="welcome-tips" aria-label={t("welcomeTipsTitle")}>
            <h2>{t("welcomeTipsTitle")}</h2>
            <ul>
              <li>{t("welcomeTipDash")}</li>
              <li>{t("welcomeTipFocus")}</li>
              <li>{t("welcomeTipOffline")}</li>
            </ul>
          </aside>
        </section>
      </div>
    );
  }

  return (
    <div className="library" {...dropProps}>
      {header}
      <section className="library-list" aria-labelledby="library-heading">
        <h1 id="library-heading" className="library-heading">
          {t("heading")} <span>— {t("sortNote")}</span>
          <span className="library-count">{t("countRecent", { count: documents.length })}</span>
          <span className="library-goal-phone">
            <DailyGoal />
          </span>
        </h1>
        <ul>
          {documents.map((doc, index) => (
            <li key={doc.id} className="library-row" data-menu-open={menuFor === doc.id ? "true" : "false"}>
              {renaming === doc.id ? (
                <RenameField
                  doc={doc}
                  onDone={async (title) => {
                    setRenaming(null);
                    if (title !== null && title !== doc.title) {
                      await store.renameDocument(doc.id, title);
                    }
                  }}
                />
              ) : (
                <a
                  ref={(element) => {
                    rows.current[index] = element;
                  }}
                  className="library-open"
                  href={`/t/${doc.id}`}
                  onClick={(event) => {
                    event.preventDefault();
                    navigate({ name: "text", id: doc.id });
                  }}
                  onDoubleClick={(event) => {
                    event.preventDefault();
                    setRenaming(doc.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "F2") {
                      event.preventDefault();
                      setRenaming(doc.id);
                    }
                  }}
                >
                  <span className="library-title" style={{ fontFamily: MODE_FONT[doc.mode] }}>
                    {doc.title || t("untitled")}
                  </span>
                  {doc.excerpt ? <span className="library-excerpt">{doc.excerpt}</span> : null}
                  <span className="library-meta">
                    {t(`mode_${doc.mode}`)} · {t(`format_${doc.pageFormat}`)} · {t("words", { count: doc.wordCount })}
                  </span>
                  <span className="library-date">
                    <time dateTime={doc.updatedAt}>{shortDate(doc.updatedAt)}</time>
                  </span>
                </a>
              )}
              <RowMenu
                title={doc.title || t("untitled")}
                open={menuFor === doc.id}
                onToggle={(open) => {
                  setMenuFor(open ? doc.id : null);
                }}
                onOpen={() => {
                  navigate({ name: "text", id: doc.id });
                }}
                onRename={() => {
                  setMenuFor(null);
                  setRenaming(doc.id);
                }}
                onHistory={() => openTextWith(doc.id, "history")}
                onExport={() => openTextWith(doc.id, "export")}
                onTrash={() => {
                  void askTrash(doc);
                }}
              />
            </li>
          ))}
        </ul>
      </section>
      {/* Téléphone : bouton principal au pouce, en bas (WF-01). */}
      <button type="button" className="button-primary library-fab" onClick={() => navigate({ name: "create" })}>
        {t("newText")}
      </button>
      {trashedToast ? (
        <div className="toast" role="status">
          <span>{t("trashed", { title: trashedToast.title || t("untitled") })}</span>
          <button
            type="button"
            onClick={() => {
              void store.restoreDocument(trashedToast.id);
              setTrashedToast(null);
            }}
          >
            {t("cancel")}
          </button>
          <button type="button" onClick={() => navigate({ name: "trash" })}>
            {t("viewTrash")}
          </button>
        </div>
      ) : null}
      {trashing ? (
        <ConfirmTrash
          title={trashing.doc.title || t("untitled")}
          onCancel={() => {
            setTrashing(null);
          }}
          onConfirm={async () => {
            const { doc, confirmationId } = trashing;
            setTrashing(null);
            await store.confirmTrash(doc.id, confirmationId);
            setTrashedToast(doc);
          }}
        />
      ) : null}
    </div>
  );
}

function RenameField({ doc, onDone }: { doc: LocalDocument; onDone: (title: string | null) => void }) {
  const t = useTranslate("library");
  const [value, setValue] = useState(doc.title);
  const done = useRef(false);
  const finish = (title: string | null) => {
    if (done.current) {
      return;
    }
    done.current = true;
    const trimmed = title?.trim() ?? null;
    onDone(trimmed === null ? null : trimmed.length > 0 ? trimmed : t("untitled"));
  };
  return (
    <input
      className="library-rename"
      aria-label={t("renameLabel")}
      autoFocus
      maxLength={200}
      value={value}
      onFocus={(event) => {
        event.currentTarget.select();
      }}
      onChange={(event) => {
        setValue(event.currentTarget.value);
      }}
      onBlur={() => {
        finish(value);
      }}
      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter") {
          finish(value);
        } else if (event.key === "Escape") {
          finish(null);
        }
      }}
    />
  );
}

function RowMenu({
  title,
  open,
  onToggle,
  onOpen,
  onRename,
  onHistory,
  onExport,
  onTrash,
}: {
  title: string;
  open: boolean;
  onToggle: (open: boolean) => void;
  onOpen: () => void;
  onRename: () => void;
  onHistory: () => void;
  onExport: () => void;
  onTrash: () => void;
}) {
  const t = useTranslate("library");
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const toggle = useRef(onToggle);
  toggle.current = onToggle;

  useEffect(() => {
    if (!open) {
      return;
    }
    menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const onPointer = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && event.target !== trigger.current) {
        toggle.current(false);
      }
    };
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      event.preventDefault();
      onToggle(false);
      trigger.current?.focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      const step = event.key === "ArrowDown" ? 1 : -1;
      items[(index + step + items.length) % items.length]?.focus();
    }
  };

  return (
    <div className="row-menu">
      <button
        ref={trigger}
        type="button"
        className="row-menu-trigger"
        aria-label={t("rowMenu", { title })}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          onToggle(!open);
        }}
      >
        ⋯
      </button>
      {open ? (
        <div ref={menu} className="row-menu-list" role="menu" onKeyDown={onKeyDown}>
          <button type="button" role="menuitem" onClick={onOpen}>
            {t("open")}
          </button>
          <button type="button" role="menuitem" onClick={onRename}>
            {t("rename")}
          </button>
          <button type="button" role="menuitem" onClick={onHistory}>
            {t("history")}
          </button>
          <button type="button" role="menuitem" onClick={onExport}>
            {t("export")}
          </button>
          <hr />
          <button type="button" role="menuitem" className="danger" onClick={onTrash}>
            {t("trash")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Confirmation de suppression, focus par défaut sur Annuler (AC-022). */
function ConfirmTrash({ title, onCancel, onConfirm }: { title: string; onCancel: () => void; onConfirm: () => void }) {
  const t = useTranslate("library");
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancel.current?.focus();
  }, []);
  return (
    <div className="dialog-veil" onClick={onCancel}>
      <div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="trash-title"
        aria-describedby="trash-body"
        onClick={(event) => {
          event.stopPropagation();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            onCancel();
          }
        }}
      >
        <h2 id="trash-title">{t("trashTitle", { title })}</h2>
        <p id="trash-body">{t("trashBody")}</p>
        <div className="dialog-actions">
          <button ref={cancel} type="button" onClick={onCancel}>
            {t("cancel")}
          </button>
          <button type="button" className="button-danger" onClick={onConfirm}>
            {t("confirmTrash")}
          </button>
        </div>
      </div>
    </div>
  );
}
