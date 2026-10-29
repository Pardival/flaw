import { FONT_SIZE_PT_MAX, FONT_SIZE_PT_MIN, schema } from "@flaw/schema/src/index.ts";
import type { Command } from "prosemirror-state";

/** Taille locale d'une sélection, ±0,5 pt autour de la taille de base (AC-011, raccourcis § 5). */
export function changeSize(delta: number, base: () => number): Command {
  return (state, dispatch) => {
    const type = schema.marks.font_size;
    const { from, to, empty } = state.selection;
    if (type === undefined || empty) {
      return false;
    }
    let current = base();
    state.doc.nodesBetween(from, to, (node) => {
      const mark = type.isInSet(node.marks);
      if (mark) {
        current = mark.attrs.pt as number;
        return false;
      }
      return true;
    });
    const next = Math.min(FONT_SIZE_PT_MAX, Math.max(FONT_SIZE_PT_MIN, Math.round((current + delta) * 2) / 2));
    if (dispatch) {
      const tr = state.tr.removeMark(from, to, type);
      if (next !== base()) {
        tr.addMark(from, to, type.create({ pt: next }));
      }
      dispatch(tr);
    }
    return true;
  };
}
