import { schema } from "@flaw/schema/src/index.ts";
import { toggleMark } from "prosemirror-commands";
import type { MarkType } from "prosemirror-model";
import { NodeSelection, type Command, type EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { useEffect, useRef, useState } from "react";

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
  // Image sélectionnée : elle a sa propre barre d'outils.
  if (empty || !view.hasFocus() || view.state.selection instanceof NodeSelection) {
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

/** Durée de la sortie (fondu) : identique à `flaw-menu-out` dans polish.css. */
const EXIT_MS = 120;

/**
 * Apparition douce : rien pendant qu'on sélectionne à la souris (le menu ne
 * clignote pas sous le pointeur), puis entrée animée au relâchement, glissement
 * quand la sélection change, et sortie en fondu au lieu d'une disparition sèche.
 */
function useMenuPresence(position: MenuPosition): { shown: MenuPosition; leaving: boolean } {
  const [pressed, setPressed] = useState(false);
  const [leaving, setLeaving] = useState<MenuPosition>(null);
  const last = useRef<MenuPosition>(null);
  const target = pressed ? null : position;

  useEffect(() => {
    const down = (event: PointerEvent) => {
      if (event.button === 0 && event.target instanceof Element && event.target.closest(".ProseMirror") !== null) {
        setPressed(true);
      }
    };
    const up = () => {
      setPressed(false);
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", up, true);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", up, true);
    };
  }, []);

  useEffect(() => {
    if (target !== null) {
      last.current = target;
      setLeaving(null);
    }
  }, [target?.top, target?.left]);

  useEffect(() => {
    if (target !== null || last.current === null) {
      return;
    }
    setLeaving(last.current);
    last.current = null;
    const timer = window.setTimeout(() => {
      setLeaving(null);
    }, EXIT_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [target === null]);

  return { shown: target ?? leaving, leaving: target === null };
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
  const { shown, leaving } = useMenuPresence(position);
  if (view === null || shown === null || mode === "screenplay") {
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
    <div
      className={leaving ? "selection-menu is-leaving" : "selection-menu"}
      role="toolbar"
      aria-label={t("format")}
      aria-hidden={leaving || undefined}
      style={{ top: shown.top, left: shown.left }}
    >
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
