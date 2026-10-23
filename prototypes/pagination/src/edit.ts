import type { Node as PMNode } from "prosemirror-model";
import { EditorState, Plugin, PluginKey, TextSelection } from "prosemirror-state";

import type { Geometry } from "./formats.ts";
import {
  createModel,
  integrate,
  textPositionNear,
  type PaginationModel,
} from "./paginate.ts";

export const paginationKey = new PluginKey<PaginationModel>("flaw-pagination");

export function paginationPlugin(initial: PaginationModel): Plugin<PaginationModel> {
  return new Plugin({
    key: paginationKey,
    state: {
      init: () => initial,
      apply(tr, previous) {
        const replacement = tr.getMeta(paginationKey) as PaginationModel | undefined;
        if (replacement !== undefined) return replacement;
        return integrate(previous, tr);
      },
    },
    props: {
      decorations(state) {
        return paginationKey.getState(state)?.decorations ?? null;
      },
    },
  });
}

export function createEditorState(doc: PMNode, geometry: Geometry): EditorState {
  const model = createModel(doc, geometry);
  const inside = textStart(doc);
  return EditorState.create({
    schema: doc.type.schema,
    doc,
    selection: TextSelection.create(doc, inside),
    plugins: [paginationPlugin(model)],
  });
}

function textStart(doc: PMNode): number {
  let found = 1;
  doc.descendants((node, pos) => {
    if (node.isText && node.text !== undefined && node.text.length > 0) {
      found = pos + 1;
      return false;
    }
  });
  return found;
}

export function modelOf(state: EditorState): PaginationModel {
  const model = paginationKey.getState(state);
  if (model === undefined) throw new Error("pagination absente");
  return model;
}

/** Remplace le modèle sans retoucher le texte. Sert à la tâche de fond. */
export function withModel(state: EditorState, model: PaginationModel): EditorState {
  return state.apply(state.tr.setMeta(paginationKey, model));
}

/**
 * Une frappe. Le temps renvoyé couvre la transaction, le compteur du bloc
 * et le mapping des décorations. Aucun chapitre n'est remesuré.
 */
export function applyCharacter(state: EditorState, character: string): {
  state: EditorState;
  syncMs: number;
} {
  const started = globalThis.performance.now();
  const next = state.apply(state.tr.insertText(character));
  return { state: next, syncMs: globalThis.performance.now() - started };
}

export function placeCaret(state: EditorState, target: number): EditorState {
  const pos = textPositionNear(state.doc, target);
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
}

export function selectionParentName(state: EditorState): string {
  return state.selection.$from.parent.type.name;
}

/** Insère un chapitre en une transaction : nouvelle page, curseur dans le titre. */
export function insertChapter(state: EditorState): EditorState {
  const after = state.selection.$from.after(1);
  const title = state.schema.nodes.chapter_title;
  if (title === undefined) throw new Error("chapter_title absent");
  const node = title.create({ align: null });
  let tr = state.tr.insert(after, node);
  tr = tr.setSelection(TextSelection.create(tr.doc, after + 1));
  return state.apply(tr);
}
