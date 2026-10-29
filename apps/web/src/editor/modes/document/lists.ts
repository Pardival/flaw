import { schema } from "@flaw/schema/src/index.ts";
import { Fragment, type Node as PMNode, type NodeType } from "prosemirror-model";
import { TextSelection, type Command, type EditorState, type Transaction } from "prosemirror-state";

/**
 * Listes à deux niveaux (R-006, AC-019) sur le schéma de @flaw/schema :
 * bullet_list | ordered_list > list_item > paragraph+ (bullet_list_2 | ordered_list_2 > list_item_2 > paragraph+)?
 * Les opérations aplatissent la liste touchée, la modifient, puis la reconstruisent.
 */
export type ListKind = "bullet" | "ordered";

type Entry = { level: 1 | 2; kind: ListKind; paragraphs: PMNode[] };

function node(name: string): NodeType {
  const found = schema.nodes[name];
  if (found === undefined) {
    throw new Error(`nœud absent : ${name}`);
  }
  return found;
}

function kindOf(type: NodeType): ListKind | null {
  if (type.name === "bullet_list" || type.name === "bullet_list_2") {
    return "bullet";
  }
  if (type.name === "ordered_list" || type.name === "ordered_list_2") {
    return "ordered";
  }
  return null;
}

function flatten(list: PMNode): Entry[] {
  const top = kindOf(list.type) ?? "bullet";
  const entries: Entry[] = [];
  list.forEach((item) => {
    const paragraphs: PMNode[] = [];
    let nested: PMNode | null = null;
    item.forEach((child) => {
      if (child.type.name === "paragraph") {
        paragraphs.push(child);
      } else {
        nested = child;
      }
    });
    entries.push({ level: 1, kind: top, paragraphs });
    const sub = nested as PMNode | null;
    if (sub !== null) {
      const subKind = kindOf(sub.type) ?? "bullet";
      sub.forEach((subItem) => {
        const subParagraphs: PMNode[] = [];
        subItem.forEach((child) => subParagraphs.push(child));
        entries.push({ level: 2, kind: subKind, paragraphs: subParagraphs });
      });
    }
  });
  return entries;
}

/** Reconstruit une ou plusieurs listes de premier niveau (une entrée de niveau 2 sans parent remonte). */
function build(entries: Entry[]): PMNode[] {
  const lists: PMNode[] = [];
  let items: PMNode[] = [];
  let kind: ListKind | null = null;
  let index = 0;
  const flush = () => {
    if (items.length > 0 && kind !== null) {
      lists.push(node(kind === "bullet" ? "bullet_list" : "ordered_list").create(null, items));
    }
    items = [];
  };
  while (index < entries.length) {
    const entry = entries[index] as Entry;
    if (kind !== null && entry.kind !== kind && entry.level === 1) {
      flush();
    }
    kind ??= entry.kind;
    if (entry.level === 1 || items.length === 0) {
      kind = entry.level === 1 ? entry.kind : kind;
      const children: PMNode[] = [...entry.paragraphs];
      index += 1;
      const subs: PMNode[] = [];
      let subKind: ListKind | null = null;
      while (index < entries.length && (entries[index] as Entry).level === 2) {
        const sub = entries[index] as Entry;
        subKind ??= sub.kind;
        subs.push(node("list_item_2").create(null, sub.paragraphs));
        index += 1;
      }
      if (subs.length > 0 && subKind !== null) {
        children.push(node(subKind === "bullet" ? "bullet_list_2" : "ordered_list_2").create(null, subs));
      }
      items.push(node("list_item").create(null, children));
    } else {
      index += 1;
    }
  }
  flush();
  return lists;
}

type Located = { list: PMNode; listPos: number; entries: Entry[]; entry: number; paragraph: number; offset: number };

/** Liste de premier niveau contenant le curseur, et la position du curseur dans le modèle aplati. */
function locate(state: EditorState): Located | null {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const candidate = $from.node(depth);
    if ((candidate.type.name === "bullet_list" || candidate.type.name === "ordered_list") && depth === 1) {
      const listPos = $from.before(depth);
      const entries = flatten(candidate);
      // Repère le paragraphe du curseur par position dans l'ordre du document.
      let seen = -1;
      let found: { entry: number; paragraph: number } | null = null;
      const target = $from.before($from.depth);
      candidate.descendants((child, pos) => {
        if (child.type.name !== "paragraph") {
          return true;
        }
        seen += 1;
        if (listPos + 1 + pos === target) {
          let count = 0;
          for (let index = 0; index < entries.length; index += 1) {
            const size = (entries[index] as Entry).paragraphs.length;
            if (seen < count + size) {
              found = { entry: index, paragraph: seen - count };
              break;
            }
            count += size;
          }
        }
        return false;
      });
      const where = found as { entry: number; paragraph: number } | null;
      if (where === null) {
        return null;
      }
      return { list: candidate, listPos, entries, entry: where.entry, paragraph: where.paragraph, offset: $from.parentOffset };
    }
  }
  return null;
}

/** Remplace la liste par `blocks` et place le curseur dans le paragraphe `target` (ordre global des paragraphes). */
function replaceList(tr: Transaction, at: Located, blocks: PMNode[], targetParagraph: number, offset: number): Transaction {
  tr.replaceWith(at.listPos, at.listPos + at.list.nodeSize, Fragment.from(blocks));
  let count = -1;
  let cursor: number | null = null;
  const end = at.listPos + blocks.reduce((sum, block) => sum + block.nodeSize, 0);
  tr.doc.nodesBetween(at.listPos, end, (child, pos) => {
    if (cursor !== null) {
      return false;
    }
    if (child.type.name === "paragraph") {
      count += 1;
      if (count === targetParagraph) {
        cursor = pos + 1 + Math.min(offset, child.content.size);
      }
      return false;
    }
    return true;
  });
  if (cursor !== null) {
    tr.setSelection(TextSelection.create(tr.doc, cursor));
  }
  return tr.scrollIntoView();
}

function paragraphIndex(entries: Entry[], entry: number, paragraph: number): number {
  let count = 0;
  for (let index = 0; index < entry; index += 1) {
    count += (entries[index] as Entry).paragraphs.length;
  }
  return count + paragraph;
}

/** Tab : descendre d'un niveau (2 au plus). */
export const sinkItem: Command = (state, dispatch) => {
  const at = locate(state);
  if (at === null) {
    return false;
  }
  const entry = at.entries[at.entry] as Entry;
  if (entry.level === 2 || at.entry === 0) {
    return true; // Tab ne sort pas de la liste.
  }
  if (dispatch) {
    const entries = at.entries.map((item) => ({ ...item }));
    (entries[at.entry] as Entry).level = 2;
    // Les sous-éléments de l'élément descendu restent au niveau 2.
    dispatch(replaceList(state.tr, at, build(entries), paragraphIndex(entries, at.entry, at.paragraph), at.offset));
  }
  return true;
};

/** Maj+Tab : remonter d'un niveau ; au premier niveau, sortir de la liste. */
export const liftItem: Command = (state, dispatch) => {
  const at = locate(state);
  if (at === null) {
    return false;
  }
  const entries = at.entries.map((item) => ({ ...item }));
  const entry = entries[at.entry] as Entry;
  if (dispatch) {
    if (entry.level === 2) {
      entry.level = 1;
      entry.kind = (entries.slice(0, at.entry).reverse().find((item) => item.level === 1) ?? entry).kind;
      dispatch(replaceList(state.tr, at, build(entries), paragraphIndex(entries, at.entry, at.paragraph), at.offset));
      return true;
    }
    // Premier niveau : l'élément devient des paragraphes ; ses sous-éléments remontent après lui.
    const before = entries.slice(0, at.entry);
    let afterStart = at.entry + 1;
    const children: Entry[] = [];
    while (afterStart < entries.length && (entries[afterStart] as Entry).level === 2) {
      children.push({ ...(entries[afterStart] as Entry), level: 1 });
      afterStart += 1;
    }
    const after = [...children, ...entries.slice(afterStart)];
    const blocks = [...build(before), ...entry.paragraphs, ...build(after)];
    const target = paragraphIndex(entries, at.entry, at.paragraph);
    dispatch(replaceList(state.tr, at, blocks, target, at.offset));
  }
  return true;
};

/** Entrée : nouvel élément ; sur un élément vide, remonter (ou sortir de la liste). */
export const splitItem: Command = (state, dispatch, view) => {
  const at = locate(state);
  if (at === null || !state.selection.empty) {
    return false;
  }
  const { $from } = state.selection;
  if ($from.parent.content.size === 0) {
    return liftItem(state, dispatch, view);
  }
  if (dispatch) {
    const entries = at.entries.map((item) => ({ ...item, paragraphs: [...item.paragraphs] }));
    const entry = entries[at.entry] as Entry;
    const current = entry.paragraphs[at.paragraph] as PMNode;
    const head = current.cut(0, at.offset);
    const tail = node("paragraph").create(current.attrs, current.content.cut(at.offset));
    const rest = entry.paragraphs.slice(at.paragraph + 1);
    entry.paragraphs = [...entry.paragraphs.slice(0, at.paragraph), head];
    entries.splice(at.entry + 1, 0, { level: entry.level, kind: entry.kind, paragraphs: [tail, ...rest] });
    dispatch(replaceList(state.tr, at, build(entries), paragraphIndex(entries, at.entry + 1, 0), 0));
  }
  return true;
};

/** Retour arrière en début d'élément : remonter (ou sortir de la liste). */
export const backspaceItem: Command = (state, dispatch, view) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset !== 0 || locate(state) === null) {
    return false;
  }
  return liftItem(state, dispatch, view);
};

/** Bascule une liste (Ctrl/⌘+Maj+4/5, menu) : crée, change de type ou retire. */
export function toggleList(kind: ListKind): Command {
  return (state, dispatch, view) => {
    const at = locate(state);
    if (at !== null) {
      const entry = at.entries[at.entry] as Entry;
      if (entry.kind === kind) {
        return liftItem(state, dispatch, view);
      }
      if (dispatch) {
        const entries = at.entries.map((item) => ({ ...item }));
        if (entry.level === 1) {
          for (const item of entries) {
            if (item.level === 1) {
              item.kind = kind;
            }
          }
        } else {
          // Sous-liste : le groupe contigu de niveau 2 autour du curseur.
          let first = at.entry;
          while (first > 0 && (entries[first - 1] as Entry).level === 2) {
            first -= 1;
          }
          for (let index = first; index < entries.length && (entries[index] as Entry).level === 2; index += 1) {
            (entries[index] as Entry).kind = kind;
          }
        }
        dispatch(replaceList(state.tr, at, build(entries), paragraphIndex(entries, at.entry, at.paragraph), at.offset));
      }
      return true;
    }
    const { $from, $to } = state.selection;
    if ($from.depth !== 1 || $to.depth !== 1) {
      return false;
    }
    const start = $from.before(1);
    const end = $to.after(1);
    const paragraphs: PMNode[] = [];
    let ok = true;
    state.doc.nodesBetween(start, end, (child) => {
      if (child.isTextblock) {
        paragraphs.push(child.type.name === "paragraph" ? child : node("paragraph").create({ align: null }, child.content));
      } else if (!child.isInline) {
        ok = false;
      }
      return false;
    });
    if (!ok || paragraphs.length === 0) {
      return false;
    }
    if (dispatch) {
      const list = node(kind === "bullet" ? "bullet_list" : "ordered_list").create(
        null,
        paragraphs.map((paragraph) => node("list_item").create(null, paragraph)),
      );
      const tr = state.tr.replaceWith(start, end, list);
      // Curseur : même décalage, dans le premier élément.
      tr.setSelection(TextSelection.create(tr.doc, Math.min(start + 3 + $from.parentOffset, start + list.nodeSize - 1)));
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

export function inList(state: EditorState): ListKind | null {
  const at = locate(state);
  return at === null ? null : (at.entries[at.entry] as Entry).kind;
}
