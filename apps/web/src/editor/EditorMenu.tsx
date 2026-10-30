import { useEffect, useRef, useState } from "react";

import { useTranslate } from "../i18n/i18n.ts";
import type { DocumentMode } from "../local-store/index.ts";

export type EditorPanel = "search" | "chapters" | "history" | "export" | "shortcuts";

/** Menu ⋯ de l'éditeur (D-034) : Rechercher, Aller au chapitre, Historique, Exporter, Raccourcis. */
export function EditorMenu({ mode, onSelect, onChapter, available = ["search", "chapters", "shortcuts"] }: {
  mode: DocumentMode;
  onSelect: (panel: EditorPanel) => void;
  /** Téléphone : « Chapitre » passe dans ce menu (WF-05 téléphone). */
  onChapter?: () => void;
  available?: EditorPanel[];
}) {
  const t = useTranslate("editor");
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) {
      return;
    }
    root.current?.querySelector<HTMLButtonElement>("[role=menuitem]:not(:disabled)")?.focus();
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);
  const items: EditorPanel[] = ["search", "chapters", "history", "export", "shortcuts"];
  return (
    <div ref={root} className="row-menu editor-menu">
      <button type="button" className="row-menu-trigger" aria-haspopup="menu" aria-expanded={open} aria-label={t("menu")} onClick={() => setOpen(!open)}>
        ⋯
      </button>
      {open ? (
        <div className="row-menu-list" role="menu" onKeyDown={(event) => event.key === "Escape" && setOpen(false)}>
          {mode === "novel" && onChapter ? (
            <button
              type="button"
              role="menuitem"
              className="editor-menu-chapter"
              onClick={() => {
                setOpen(false);
                onChapter();
              }}
            >
              {t("insertChapter")}
            </button>
          ) : null}
          {items
            .filter((item) => item !== "chapters" || mode === "novel")
            .map((item) => (
              <button
                key={item}
                type="button"
                role="menuitem"
                disabled={!available.includes(item)}
                onClick={() => {
                  setOpen(false);
                  onSelect(item);
                }}
              >
                {t(`menu_${item}`)}
              </button>
            ))}
        </div>
      ) : null}
    </div>
  );
}
