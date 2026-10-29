import { schema } from "@flaw/schema/src/index.ts";
import type { NodeType } from "prosemirror-model";
import { TextSelection, type Command, type EditorState } from "prosemirror-state";

/** Éléments du script (A-018), dans l'ordre des raccourcis Ctrl/⌘+Maj+1…6. */
export const SCRIPT_ELEMENTS = ["scene_heading", "action", "character", "parenthetical", "dialogue", "transition"] as const;

export type ScriptElement = (typeof SCRIPT_ELEMENTS)[number] | "centered";

function type(name: string): NodeType {
  const found = schema.nodes[name];
  if (found === undefined) {
    throw new Error(`nœud absent : ${name}`);
  }
  return found;
}

function current(state: EditorState): { name: string; empty: boolean; atEnd: boolean } {
  const { $from } = state.selection;
  return {
    name: $from.parent.type.name,
    empty: $from.parent.content.size === 0,
    atEnd: $from.parentOffset === $from.parent.content.size,
  };
}

/** Change l'élément de la ligne courante. */
export function setElement(name: string): Command {
  return (state, dispatch) => {
    const { $from, $to } = state.selection;
    const target = type(name);
    if (!$from.parent.isTextblock) {
      return false;
    }
    if (dispatch) {
      dispatch(state.tr.setBlockType($from.pos, $to.pos, target, { align: null }).scrollIntoView());
    }
    return true;
  };
}

/** Nouvelle ligne d'un élément donné après la ligne courante (le texte après le curseur suit). */
function newLine(name: string): Command {
  return (state, dispatch) => {
    const { $from } = state.selection;
    if (!$from.parent.isTextblock) {
      return false;
    }
    if (dispatch) {
      const tr = state.tr;
      if (!state.selection.empty) {
        tr.deleteSelection();
      }
      const pos = tr.selection.from;
      tr.split(pos, 1, [{ type: type(name), attrs: { align: null } }]);
      tr.setSelection(TextSelection.create(tr.doc, pos + 2)).scrollIntoView();
      dispatch(tr);
    }
    return true;
  };
}

const SCENE = /^(INT\.|EXT\.|INT\.\/EXT\.|EXT\.\/INT\.|I\/E\.?)\s/iu;
const TRANSITION = /^[A-ZÀ-Ý0-9 .'’–-]+:$/u;

/**
 * Aides à la Fountain : une action qui commence par INT./EXT. devient une scène ;
 * une ligne en majuscules qui finit par « : » devient une transition.
 */
function fountainHint(state: EditorState): string | null {
  const { $from } = state.selection;
  if ($from.parent.type.name !== "action") {
    return null;
  }
  const text = $from.parent.textContent.trim();
  if (SCENE.test(text)) {
    return "scene_heading";
  }
  if (text.length > 1 && TRANSITION.test(text)) {
    return "transition";
  }
  return null;
}

/** Entrée (raccourcis § 8.1) : « suit la conversation » ; ligne vide = action. */
const enter: Command = (state, dispatch, view) => {
  const here = current(state);
  if (!SCRIPT_ELEMENTS.includes(here.name as never) && here.name !== "centered") {
    return false;
  }
  if (here.empty) {
    if (here.name === "action") {
      return newLine("action")(state, dispatch, view);
    }
    return setElement("action")(state, dispatch, view);
  }
  const hint = fountainHint(state);
  if (hint !== null && dispatch) {
    const { $from } = state.selection;
    const tr = state.tr.setBlockType($from.pos, $from.pos, type(hint), { align: null });
    const after = state.apply(tr);
    dispatch(tr);
    return newLine(hint === "scene_heading" ? "action" : "scene_heading")(after, dispatch, view);
  }
  const next: Record<string, string> = {
    scene_heading: "action",
    action: "action",
    character: "dialogue",
    parenthetical: "dialogue",
    dialogue: "character",
    transition: "scene_heading",
    centered: "action",
  };
  return newLine(next[here.name] ?? "action")(state, dispatch, view);
};

/** Tab : ouvre l'élément « secondaire ». */
const tab: Command = (state, dispatch, view) => {
  const here = current(state);
  switch (here.name) {
    case "scene_heading":
      return here.empty ? setElement("action")(state, dispatch, view) : newLine("action")(state, dispatch, view);
    case "action":
      return here.empty ? setElement("character")(state, dispatch, view) : newLine("character")(state, dispatch, view);
    case "character":
      return here.empty ? setElement("transition")(state, dispatch, view) : newLine("parenthetical")(state, dispatch, view);
    case "parenthetical":
      return newLine("dialogue")(state, dispatch, view);
    case "dialogue":
      return here.empty ? setElement("parenthetical")(state, dispatch, view) : newLine("parenthetical")(state, dispatch, view);
    case "transition":
      return here.empty ? setElement("scene_heading")(state, dispatch, view) : newLine("scene_heading")(state, dispatch, view);
    default:
      return false;
  }
};

/** Maj+Tab : ressort toujours vers l'action (depuis l'action : scène). */
const shiftTab: Command = (state, dispatch, view) => {
  const here = current(state);
  if (here.name === "action") {
    return setElement("scene_heading")(state, dispatch, view);
  }
  if (!SCRIPT_ELEMENTS.includes(here.name as never) && here.name !== "centered") {
    return false;
  }
  return setElement("action")(state, dispatch, view);
};

export function scriptKeys(): Record<string, Command> {
  const keys: Record<string, Command> = {
    Enter: enter,
    Tab: tab,
    "Shift-Tab": shiftTab,
  };
  SCRIPT_ELEMENTS.forEach((name, index) => {
    const digit = String(index + 1);
    keys[`Ctrl-Shift-${digit}`] = setElement(name);
    keys[`Mod-Alt-${digit}`] = setElement(name);
  });
  return keys;
}
