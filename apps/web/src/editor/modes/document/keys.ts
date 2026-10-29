import { schema } from "@flaw/schema/src/index.ts";
import { chainCommands, splitBlock } from "prosemirror-commands";
import { Plugin, TextSelection, type Command } from "prosemirror-state";

import { backspaceItem, liftItem, sinkItem, splitItem, toggleList } from "./lists.ts";

/** Titre 1 à 3 en bascule : refaire le même raccourci revient au paragraphe. */
export function toggleHeading(level: 1 | 2 | 3): Command {
  return (state, dispatch) => {
    const { $from, $to } = state.selection;
    const heading = schema.nodes.heading;
    const paragraph = schema.nodes.paragraph;
    if (heading === undefined || paragraph === undefined || !$from.parent.isTextblock || $from.depth !== 1) {
      return false;
    }
    const same = $from.parent.type === heading && $from.parent.attrs.level === level;
    if (dispatch) {
      const align = ($from.parent.attrs.align as string | null | undefined) ?? null;
      dispatch(
        state.tr
          .setBlockType($from.pos, $to.pos, same ? paragraph : heading, same ? { align } : { level, align })
          .scrollIntoView(),
      );
    }
    return true;
  };
}

/** Retour arrière en début de titre : paragraphe. */
const backspaceHeading: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  const paragraph = schema.nodes.paragraph;
  if (!empty || $from.parentOffset !== 0 || $from.parent.type.name !== "heading" || paragraph === undefined) {
    return false;
  }
  if (dispatch) {
    dispatch(state.tr.setBlockType($from.pos, $from.pos, paragraph, { align: null }));
  }
  return true;
};

export function documentKeys(): Record<string, Command> {
  const keys: Record<string, Command> = {
    Enter: chainCommands(splitItem, splitBlock),
    Tab: (state, dispatch, view) => sinkItem(state, dispatch, view) || true,
    "Shift-Tab": (state, dispatch, view) => liftItem(state, dispatch, view) || true,
    Backspace: chainCommands(backspaceItem, backspaceHeading),
  };
  for (const level of [1, 2, 3] as const) {
    keys[`Ctrl-Shift-${String(level)}`] = toggleHeading(level);
    keys[`Mod-Alt-${String(level)}`] = toggleHeading(level);
  }
  keys["Ctrl-Shift-4"] = toggleList("bullet");
  keys["Mod-Alt-4"] = toggleList("bullet");
  keys["Ctrl-Shift-5"] = toggleList("ordered");
  keys["Mod-Alt-5"] = toggleList("ordered");
  return keys;
}

/** Saisie en début de ligne : `# `, `## `, `### `, `- `, `* `, `1. ` (raccourcis § 7). */
export function documentInputRules(): Plugin {
  return new Plugin({
    props: {
      handleTextInput(view, from, to, text) {
        if (text !== " ") {
          return false;
        }
        const state = view.state;
        const $from = state.doc.resolve(from);
        if ($from.parent.type.name !== "paragraph" || from !== to) {
          return false;
        }
        const before = $from.parent.textBetween(0, $from.parentOffset);
        let command: Command | null = null;
        if (/^#{1,3}$/u.test(before) && $from.depth === 1) {
          command = toggleHeading(before.length as 1 | 2 | 3);
        } else if ((before === "-" || before === "*") && $from.depth === 1) {
          command = toggleList("bullet");
        } else if (before === "1." && $from.depth === 1) {
          command = toggleList("ordered");
        }
        if (command === null) {
          return false;
        }
        const start = from - before.length;
        const cleared = state.tr.delete(start, from);
        cleared.setSelection(TextSelection.create(cleared.doc, start));
        if (!command(state.apply(cleared))) {
          return false;
        }
        view.dispatch(cleared);
        command(view.state, view.dispatch, view);
        return true;
      },
    },
  });
}
