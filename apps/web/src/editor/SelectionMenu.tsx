import { schema } from "@flaw/schema/src/index.ts";
import { toggleMark } from "prosemirror-commands";
import type { MarkType } from "prosemirror-model";
import type { Command, EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

import { useTranslate } from "../i18n/i18n.ts";
import type { DocumentMode } from "../local-store/index.ts";
import { toggleHeading } from "./modes/document/keys.ts";
import { inList, toggleList } from "./modes/document/lists.ts";
import { setAlign } from "./commands.ts";
import { changeSize } from "./size.ts";

/** Taille affichée : celle de la sélection si elle a une marque, sinon la taille de base. */
function currentSize(state: EditorState, base: number): number {
  const type = schema.marks.font_size;
  if (type === undefined) {
    return base;
  }
  let size = base;
  state.doc.nodesBetween(state.selection.from, state.selection.to, (node) => {
    const mark = type.isInSet(node.marks);
    if (mark) {
      size = mark.attrs.pt as number;
      return false;
    }
    return true;
  });
  return size;
}

export type MenuPosition = { top: number; left: number } | null;

/** Position du menu au-dessus de la sélection, ou null si rien n'est sélectionné. */
export function menuPosition(view: EditorView): MenuPosition {
  const { from, to, empty } = view.state.selection;
  if (empty || !view.hasFocus()) {
    return null;
  }
  try {
    const start = view.coordsAtPos(from);
    const end = view.coordsAtPos(to);
    return { top: Math.min(start.top, end.top) + window.scrollY, left: (start.left + end.left) / 2 + window.scrollX };
  } catch {
    return null;
  }
}

function markActive(state: EditorState, type: MarkType | undefined): boolean {
  if (type === undefined) {
    return false;
  }
  const { from, to, empty, $from } = state.selection;
  return empty ? type.isInSet(state.storedMarks ?? $from.marks()) !== undefined : state.doc.rangeHasMark(from, to, type);
}

/**
 * Menu de mise en forme à la sélection (F3, D-031) : gras, italique ; en document,
 * titres 1 à 3, puces et numéros. Les mêmes actions existent au clavier.
 */
export function SelectionMenu({
  view,
  mode,
  position,
  baseSize,
}: {
  view: EditorView | null;
  mode: DocumentMode;
  position: MenuPosition;
  baseSize: () => number;
}) {
  const t = useTranslate("editor");
  if (view === null || position === null || mode === "screenplay") {
    return null;
  }
  const state = view.state;
  const run = (command: Command) => {
    command(view.state, view.dispatch, view);
    view.focus();
  };
  const heading = state.selection.$from.parent.type.name === "heading" ? (state.selection.$from.parent.attrs.level as number) : 0;
  const list = mode === "document" ? inList(state) : null;
  const align = state.selection.$from.parent.attrs.align as string | null | undefined;
  const button = (label: string, title: string, active: boolean, command: Command) => (
    <button
      type="button"
      aria-pressed={active}
      title={title}
      onPointerDown={(event) => {
        event.preventDefault();
      }}
      onClick={() => {
        run(command);
      }}
    >
      {label}
    </button>
  );
  const bold = schema.marks.bold;
  const italic = schema.marks.italic;
  return (
    <div className="selection-menu" role="toolbar" aria-label={t("format")} style={{ top: position.top, left: position.left }}>
      {bold ? button("B", t("bold"), markActive(state, bold), toggleMark(bold)) : null}
      {italic ? button("I", t("italic"), markActive(state, italic), toggleMark(italic)) : null}
      <span className="selection-menu-sep" />
      {button("−", t("smaller"), false, changeSize(-0.5, baseSize))}
      <span className="selection-menu-size" aria-label={t("size")}>
        {currentSize(state, baseSize()).toLocaleString("fr-FR")}
      </span>
      {button("+", t("larger"), false, changeSize(0.5, baseSize))}
      <span className="selection-menu-sep" />
      {button("⇤", t("alignLeft"), align === "left", setAlign("left"))}
      {button("↔", t("alignCenter"), align === "center", setAlign("center"))}
      {button("⇥", t("alignRight"), align === "right", setAlign("right"))}
      {button("☰", t("alignJustify"), align === "justify", setAlign("justify"))}
      {mode === "document" ? (
        <>
          <span className="selection-menu-sep" />
          {button("T1", t("heading1"), heading === 1, toggleHeading(1))}
          {button("T2", t("heading2"), heading === 2, toggleHeading(2))}
          {button("T3", t("heading3"), heading === 3, toggleHeading(3))}
          <span className="selection-menu-sep" />
          {button("•", t("bullets"), list === "bullet", toggleList("bullet"))}
          {button("1.", t("numbers"), list === "ordered", toggleList("ordered"))}
        </>
      ) : null}
    </div>
  );
}
