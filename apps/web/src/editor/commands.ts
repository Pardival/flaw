import { schema, parsePastedHtml } from "@flaw/schema/src/index.ts";
import { baseKeymap, chainCommands, splitBlock, toggleMark } from "prosemirror-commands";
import { keymap } from "prosemirror-keymap";
import { Fragment, Slice, type Node as PMNode } from "prosemirror-model";
import { Plugin, TextSelection, type Command, type EditorState } from "prosemirror-state";
import { redo, undo } from "y-prosemirror";

import type { DocumentMode } from "../local-store/index.ts";
import { documentInputRules, documentKeys } from "./modes/document/keys.ts";
import { scriptKeys } from "./modes/script/keys.ts";

const ALIGN_KEYS: Record<string, "left" | "center" | "right" | "justify"> = {
  "7": "left",
  "8": "center",
  "9": "right",
  "0": "justify",
};

/** Insère un chapitre en une transaction : nouvelle page, curseur dans le titre (AC-012). */
export const insertChapter: Command = (state, dispatch) => {
  const type = schema.nodes.chapter_title;
  if (type === undefined) {
    return false;
  }
  const after = state.selection.$from.depth > 0 ? state.selection.$from.after(1) : state.doc.content.size;
  if (dispatch) {
    const tr = state.tr.insert(after, type.create({ align: null }));
    tr.setSelection(TextSelection.create(tr.doc, after + 1)).scrollIntoView();
    dispatch(tr);
  }
  return true;
};

/** `***` puis Entrée : séparateur de scène, puis nouveau paragraphe (raccourcis § 6). */
const sceneBreakOnEnter: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  const parent = $from.parent;
  if (!empty || parent.type !== schema.nodes.paragraph || parent.textContent.trim() !== "***") {
    return false;
  }
  const sceneBreak = schema.nodes.scene_break;
  const paragraph = schema.nodes.paragraph;
  if (sceneBreak === undefined || paragraph === undefined) {
    return false;
  }
  if (dispatch) {
    const start = $from.before();
    const end = $from.after();
    const tr = state.tr.replaceWith(start, end, [sceneBreak.create(), paragraph.create({ align: null })]);
    tr.setSelection(TextSelection.create(tr.doc, start + 2)).scrollIntoView();
    dispatch(tr);
  }
  return true;
};

export function setAlign(align: "left" | "center" | "right" | "justify"): Command {
  return (state, dispatch) => {
    const { from, to } = state.selection;
    let applicable = false;
    state.doc.nodesBetween(from, to, (node) => {
      if (node.isTextblock && "align" in node.attrs) {
        applicable = true;
      }
    });
    if (!applicable) {
      return false;
    }
    if (dispatch) {
      const tr = state.tr;
      state.doc.nodesBetween(from, to, (node, pos) => {
        if (node.isTextblock && "align" in node.attrs) {
          // Refaire le même alignement revient à l'alignement par défaut.
          tr.setNodeAttribute(pos, "align", node.attrs.align === align ? null : align);
        }
      });
      dispatch(tr);
    }
    return true;
  };
}

function commonKeys(): Record<string, Command> {
  const bold = schema.marks.bold;
  const italic = schema.marks.italic;
  const keys: Record<string, Command> = {
    "Mod-z": undo,
    "Mod-y": redo,
    "Mod-Shift-z": redo,
  };
  if (bold !== undefined) {
    keys["Mod-b"] = toggleMark(bold);
  }
  if (italic !== undefined) {
    keys["Mod-i"] = toggleMark(italic);
  }
  for (const [digit, align] of Object.entries(ALIGN_KEYS)) {
    keys[`Ctrl-Shift-${digit}`] = setAlign(align);
    keys[`Mod-Alt-${digit}`] = setAlign(align);
  }
  return keys;
}

function novelKeys(onChapter: () => void): Record<string, Command> {
  const chapter: Command = (state, dispatch) => {
    const done = insertChapter(state, dispatch);
    if (done && dispatch) {
      onChapter();
    }
    return done;
  };
  return {
    "Mod-Shift-Enter": chapter,
    Enter: chainCommands(sceneBreakOnEnter, splitBlock),
  };
}

export function editorKeymaps(mode: DocumentMode, hooks: { onChapter: () => void }): Plugin[] {
  const modeKeys =
    mode === "novel" ? novelKeys(hooks.onChapter) : mode === "screenplay" ? scriptKeys() : mode === "document" ? documentKeys() : {};
  const rules = mode === "document" ? [documentInputRules()] : [];
  return [...rules, keymap(modeKeys), keymap(commonKeys()), keymap(baseKeymap)];
}

function plainSlice(text: string): Slice {
  const paragraph = schema.nodes.paragraph;
  if (paragraph === undefined) {
    return Slice.empty;
  }
  const blocks = text
    .replace(/\r\n?/gu, "\n")
    .split(/\n{2,}|\n/u)
    .map((line) => paragraph.create({ align: null }, line.length > 0 ? schema.text(line) : null));
  return new Slice(Fragment.from(blocks), 1, 1);
}

/**
 * Collage filtré par le schéma (SEC-WEB-06) : le HTML passe par parsePastedHtml,
 * jamais par le DOM ; sinon le texte brut devient des paragraphes.
 */
export function pastePlugin(): Plugin {
  return new Plugin({
    props: {
      handlePaste(view, event) {
        const data = event.clipboardData;
        if (data === null) {
          return false;
        }
        const html = data.getData("text/html");
        let slice: Slice;
        if (html.length > 0) {
          let parsed: PMNode;
          try {
            parsed = parsePastedHtml(html);
          } catch {
            slice = plainSlice(data.getData("text/plain"));
            view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView());
            return true;
          }
          slice = new Slice(parsed.content, 1, 1);
        } else {
          const text = data.getData("text/plain");
          if (text.length === 0) {
            return true;
          }
          slice = plainSlice(text);
        }
        view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView());
        return true;
      },
      handleDrop() {
        // Aucun dépôt de contenu externe dans l'éditeur en v1 (import : T-040).
        return false;
      },
    },
  });
}

export function selectionInside(state: EditorState, name: string): boolean {
  return state.selection.$from.parent.type.name === name;
}
