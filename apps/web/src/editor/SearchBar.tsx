import type { EditorView } from "prosemirror-view";
import { useEffect, useRef, useState } from "react";

import { useTranslate } from "../i18n/i18n.ts";
import { closeSearch, searchState, setQuery, step } from "./search.ts";

/** Barre de recherche (D-035) : « 3 sur 12 », Entrée / Maj+Entrée, Échap. */
export function SearchBar({ view, onClose }: { view: EditorView; onClose: () => void }) {
  const t = useTranslate("editor");
  const input = useRef<HTMLInputElement>(null);
  const [query, setValue] = useState(() => searchState(view.state).query);
  const [, force] = useState(0);
  const state = searchState(view.state);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const close = () => {
    closeSearch(view);
    onClose();
    view.focus();
  };

  return (
    <div className="search-bar" role="search">
      <input
        ref={input}
        type="search"
        value={query}
        aria-label={t("search")}
        placeholder={t("search")}
        onChange={(event) => {
          setValue(event.currentTarget.value);
          setQuery(view, event.currentTarget.value);
          force((count) => count + 1);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || ((event.ctrlKey || event.metaKey) && (event.key === "g" || event.key === "G"))) {
            event.preventDefault();
            step(view, event.shiftKey ? -1 : 1);
            force((count) => count + 1);
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
        }}
      />
      <span className="search-count" aria-live="polite">
        {query.length === 0 ? "" : state.matches.length === 0 ? t("noMatch") : t("matchOf", { n: state.current + 1, total: state.matches.length })}
      </span>
      <button type="button" aria-label={t("previous")} onClick={() => { step(view, -1); force((c) => c + 1); }}>
        ↑
      </button>
      <button type="button" aria-label={t("next")} onClick={() => { step(view, 1); force((c) => c + 1); }}>
        ↓
      </button>
      <button type="button" aria-label={t("closeSearch")} onClick={close}>
        ×
      </button>
    </div>
  );
}
