import { Plugin, type EditorState, type Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { yUndoPluginKey } from "y-prosemirror";

import type { DocumentMode } from "../local-store/index.ts";

/**
 * Typographie française à la frappe (F20, D-103, A-006).
 * Roman, document, page blanche : U+202F avant ; ! ? et U+00A0 avant « : » et dans « ».
 * Script : U+00A0 partout (chasse fixe). Rien dans une heure, une adresse, après une
 * espace déjà insécable, ni dans les éléments personnage et transition.
 * L'espace est une transaction à part : Ctrl/⌘+Z l'annule seule (AC-072).
 * Deux traits d'union « -- » deviennent un tiret de dialogue « — » (suivi d'une espace
 * insécable en début de paragraphe) ; Ctrl/⌘+Z rend les deux traits.
 */
export const NNBSP = " ";
export const NBSP = " ";

const THIN_BEFORE = new Set([";", "!", "?"]);
const EXCLUDED_NODES = new Set(["character", "transition"]);
const SPACES = new Set([" ", NBSP, NNBSP, "\t"]);

export type TypographyOptions = { enabled: () => boolean; mode: () => DocumentMode };

/** Adresse web ou courriel en cours de frappe : aucun ajout. */
function looksLikeAddress(before: string): boolean {
  const word = before.split(/\s/u).pop() ?? "";
  return /:\/\/|^www\.|@/iu.test(word) || /^(https?|mailto|ftp)$/iu.test(word);
}

function spaceFor(char: string, mode: DocumentMode): string {
  if (mode === "screenplay") {
    return NBSP;
  }
  return THIN_BEFORE.has(char) ? NNBSP : NBSP;
}

function stopCapturing(state: EditorState): void {
  const undo = yUndoPluginKey.getState(state)?.undoManager as { stopCapturing?: () => void } | undefined;
  undo?.stopCapturing?.();
}

/** Insère `char` puis, si la règle s'applique, l'espace insécable dans une transaction distincte. */
function apply(view: EditorView, from: number, to: number, char: string, options: TypographyOptions): boolean {
  const state = view.state;
  const $from = state.doc.resolve(from);
  if (EXCLUDED_NODES.has($from.parent.type.name)) {
    return false;
  }
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "￼");
  const previous = before.slice(-1);
  const mode = options.mode();

  if (THIN_BEFORE.has(char) || char === ":") {
    if (previous === "" || SPACES.has(previous) && previous !== " ") {
      return false;
    }
    // Heure (14:05) ou nombre : aucun ajout.
    if (char === ":" && /\d$/u.test(before)) {
      return false;
    }
    if (looksLikeAddress(before)) {
      return false;
    }
    // « !! » ou « ?! » : la deuxième ponctuation suit la première sans espace.
    if (THIN_BEFORE.has(previous)) {
      return false;
    }
    const space = spaceFor(char, mode);
    const replaceSpace = previous === " ";
    const tr: Transaction = state.tr.insertText(char, from, to);
    view.dispatch(tr);
    stopCapturing(view.state);
    const at = from;
    const spaced = replaceSpace ? view.state.tr.insertText(space, at - 1, at) : view.state.tr.insertText(space, at, at);
    view.dispatch(spaced);
    stopCapturing(view.state);
    return true;
  }

  if (char === "«") {
    view.dispatch(state.tr.insertText(char, from, to));
    stopCapturing(view.state);
    view.dispatch(view.state.tr.insertText(NBSP, from + 1, from + 1));
    stopCapturing(view.state);
    return true;
  }

  if (char === "»") {
    if (previous === "" || previous === NBSP || previous === NNBSP) {
      return false;
    }
    const replaceSpace = previous === " ";
    view.dispatch(state.tr.insertText(char, from, to));
    stopCapturing(view.state);
    view.dispatch(replaceSpace ? view.state.tr.insertText(NBSP, from - 1, from) : view.state.tr.insertText(NBSP, from, from));
    stopCapturing(view.state);
    return true;
  }

  // Guillemet droit en début de mot : guillemets français.
  if (char === '"') {
    const opening = previous === "" || SPACES.has(previous) || /[([{—–-]/u.test(previous);
    if (opening) {
      view.dispatch(state.tr.insertText("«", from, to));
      stopCapturing(view.state);
      view.dispatch(view.state.tr.insertText(NBSP, from + 1, from + 1));
      stopCapturing(view.state);
      return true;
    }
    return apply(view, from, to, "»", options);
  }
  return false;
}

export const EM_DASH = "—";

/** « -- » → « — » : le second trait est d'abord inséré tel quel, puis remplacé à part. */
function dialogueDash(view: EditorView, from: number, to: number): boolean {
  const $from = view.state.doc.resolve(from);
  if (EXCLUDED_NODES.has($from.parent.type.name) || from !== to) {
    return false;
  }
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "￼");
  if (!before.endsWith("-") || before.endsWith("--")) {
    return false;
  }
  view.dispatch(view.state.tr.insertText("-", from, to));
  stopCapturing(view.state);
  // En tête de paragraphe, le tiret ne reste jamais seul en fin de ligne.
  const dash = before === "-" ? EM_DASH + NBSP : EM_DASH;
  view.dispatch(view.state.tr.insertText(dash, from - 1, from + 1));
  stopCapturing(view.state);
  return true;
}

export function typographyPlugin(options: TypographyOptions): Plugin {
  return new Plugin({
    props: {
      handleTextInput(view, from, to, text) {
        if (text === "-" && dialogueDash(view, from, to)) {
          return true;
        }
        // « -- » puis espace : le tiret porte déjà son espace insécable, on n'en ajoute pas une seconde.
        if (text === " " && from === to) {
          const $from = view.state.doc.resolve(from);
          if ($from.parent.textBetween(0, $from.parentOffset, undefined, "￼") === EM_DASH + NBSP) {
            return true;
          }
        }
        if (!options.enabled() || text.length !== 1) {
          return false;
        }
        return apply(view, from, to, text, options);
      },
    },
  });
}

/** Changement de mode vers ou depuis le script : U+202F ↔ U+00A0 devant ; ! ? (AC-073). */
export function convertSpacesForMode(tr: Transaction, toScript: boolean): Transaction {
  const from = toScript ? NNBSP : NBSP;
  const to = toScript ? NBSP : NNBSP;
  const edits: number[] = [];
  tr.doc.descendants((node, pos) => {
    if (!node.isText || node.text === undefined) {
      return;
    }
    const text = node.text;
    for (let index = 0; index < text.length - 1; index += 1) {
      if (text[index] === from && THIN_BEFORE.has(text[index + 1] ?? "")) {
        edits.push(pos + index);
      }
    }
  });
  for (const pos of edits) {
    tr.insertText(to, pos, pos + 1);
  }
  return tr;
}
