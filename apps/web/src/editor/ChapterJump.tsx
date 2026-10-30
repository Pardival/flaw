import type { EditorView } from "prosemirror-view";
import { TextSelection } from "prosemirror-state";
import { useEffect, useRef, useState } from "react";

import { useTranslate } from "../i18n/i18n.ts";
import { paginationOf } from "./pagination/plugin.ts";
import { useClosing } from "../shell/presence.ts";

/** Aller au chapitre (D-036, AC-068) : liste filtrable, chapitre courant, pages ; ↑ ↓ puis Entrée. */
export function ChapterJump({ view, onClose: closeNow }: { view: EditorView; onClose: () => void }) {
  const t = useTranslate("editor");
  const { closing, close: onClose } = useClosing(closeNow);
  const [filter, setFilter] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const model = paginationOf(view.state);
  const head = view.state.selection.from;
  const chapters = (model?.chapters ?? []).filter((chapter) => chapter.title.length > 0 || chapter.index > 0);
  const shown = chapters.filter((chapter) => chapter.title.toLowerCase().includes(filter.trim().toLowerCase()));

  useEffect(() => {
    input.current?.focus();
  }, []);

  const go = (index: number) => {
    const chapter = shown[index];
    if (!chapter) {
      return;
    }
    const pos = Math.min(chapter.from + 1, view.state.doc.content.size);
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos))).scrollIntoView());
    onClose();
    view.focus();
  };

  return (
    <div className={`dialog-veil${closing ? " is-closing" : ""}`} onClick={onClose}>
      <div className="dialog chapter-jump" role="dialog" aria-label={t("goToChapter")} onClick={(event) => event.stopPropagation()}>
        <input
          ref={input}
          value={filter}
          placeholder={t("filterChapters")}
          aria-label={t("filterChapters")}
          onChange={(event) => {
            setFilter(event.currentTarget.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((value) => Math.min(shown.length - 1, value + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((value) => Math.max(0, value - 1));
            } else if (event.key === "Enter") {
              event.preventDefault();
              go(active);
            } else if (event.key === "Escape") {
              onClose();
            }
          }}
        />
        <ul role="listbox">
          {shown.map((chapter, index) => {
            const current = head >= chapter.from && head <= chapter.to;
            const first = chapter.pages[0]?.folio;
            return (
              <li key={`${String(chapter.index)}-${String(chapter.from)}`} role="option" aria-selected={index === active}>
                <button type="button" onClick={() => go(index)} data-current={current ? "true" : "false"}>
                  <span>{chapter.title || t("untitledChapter")}</span>
                  <span className="chapter-page">{first === undefined ? "…" : t("pageShort", { n: String(first) })}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
