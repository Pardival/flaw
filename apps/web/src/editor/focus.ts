import { Plugin, PluginKey, type EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

/**
 * Mode focus (F11, T-027) : le même éditeur, lié au même Y.Doc, réduit à une ligne.
 * Chaque frappe part dans le Y.Doc et IndexedDB : rien n'est perdu si l'onglet se ferme.
 * Retour arrière n'efface que dans la ligne en cours ; on ne remonte pas dans le texte.
 */
export const focusKey = new PluginKey<boolean>("flaw-focus");

export function inFocus(state: EditorState): boolean {
  return focusKey.getState(state) === true;
}

function lineStart(view: EditorView): boolean {
  const { $head, empty } = view.state.selection;
  if (!empty) {
    return false;
  }
  if ($head.parentOffset === 0) {
    return true;
  }
  try {
    const here = view.coordsAtPos($head.pos, 1);
    const before = view.coordsAtPos($head.pos - 1, 1);
    return Math.abs(here.top - before.top) > 2;
  } catch {
    return false;
  }
}

const BLOCKED = new Set(["ArrowUp", "PageUp", "Home"]);

export function focusPlugin(): Plugin<boolean> {
  return new Plugin<boolean>({
    key: focusKey,
    state: {
      init: () => false,
      apply(tr, previous) {
        const next = tr.getMeta(focusKey) as boolean | undefined;
        return next ?? previous;
      },
    },
    props: {
      handleKeyDown(view, event) {
        if (!inFocus(view.state)) {
          return false;
        }
        if (event.key === "Backspace" && lineStart(view)) {
          // Rien au-delà de la ligne en cours (AC-037).
          return true;
        }
        if (BLOCKED.has(event.key) || (event.key === "ArrowLeft" && lineStart(view))) {
          return true;
        }
        if ((event.metaKey || event.ctrlKey) && (event.key === "a" || event.key === "A")) {
          return true;
        }
        return false;
      },
      attributes(state): Record<string, string> {
        // Correcteur coupé en focus.
        return inFocus(state) ? { spellcheck: "false", "data-focus": "true" } : {};
      },
    },
  });
}

export function setFocusMode(view: EditorView, active: boolean): void {
  view.dispatch(view.state.tr.setMeta(focusKey, active).setMeta("addToHistory", false));
}

/** Haut de la ligne du curseur, à l'écran. */
export function caretTop(view: EditorView): number | null {
  try {
    return view.coordsAtPos(view.state.selection.head).top;
  } catch {
    return null;
  }
}
