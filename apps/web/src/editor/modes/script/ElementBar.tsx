import type { EditorView } from "prosemirror-view";

import { useTranslate } from "../../../i18n/i18n.ts";
import { SCRIPT_ELEMENTS, setElement } from "./keys.ts";

/**
 * Barre d'éléments (D-029, AC-017) : nom de l'élément courant sur ordinateur,
 * boutons au-dessus du clavier sur téléphone (aussi en focus, version discrète).
 */
export function ElementBar({ view, current, discreet = false }: { view: EditorView | null; current: string; discreet?: boolean }) {
  const t = useTranslate("editor");
  return (
    <div className="element-bar" data-discreet={discreet ? "true" : "false"} role="toolbar" aria-label={t("elements")}>
      {SCRIPT_ELEMENTS.map((name) => (
        <button
          key={name}
          type="button"
          aria-pressed={current === name}
          onPointerDown={(event) => {
            // Garde le focus et le clavier ouverts.
            event.preventDefault();
          }}
          onClick={() => {
            if (view) {
              setElement(name)(view.state, view.dispatch, view);
              view.focus();
            }
          }}
        >
          {t(`element_${name}`)}
        </button>
      ))}
    </div>
  );
}
