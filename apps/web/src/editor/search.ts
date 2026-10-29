import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey, TextSelection, type EditorState } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";

/**
 * Recherche sur le modèle ProseMirror (F19, AC-067) : trouve toute occurrence, même
 * dans les pages hors écran ou les blocs non rendus (content-visibility).
 * Insensible à la casse et aux accents ; occurrence courante surlignée.
 */
export type Match = { from: number; to: number };
export type SearchState = { query: string; matches: Match[]; current: number; decorations: DecorationSet };

export const searchKey = new PluginKey<SearchState>("flaw-search");

function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

export function findMatches(doc: PMNode, query: string): Match[] {
  const needle = fold(query);
  if (needle.length === 0) {
    return [];
  }
  const matches: Match[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) {
      return true;
    }
    // Texte du bloc et correspondance caractère → position.
    let text = "";
    const offsets: number[] = [];
    node.forEach((child, offset) => {
      if (child.isText && child.text !== undefined) {
        for (let index = 0; index < child.text.length; index += 1) {
          offsets.push(pos + 1 + offset + index);
        }
        text += child.text;
      }
    });
    // La normalisation ne change pas la longueur des lettres latines usuelles.
    const haystack = fold(text);
    let from = haystack.indexOf(needle);
    while (from !== -1) {
      const start = offsets[from];
      const end = offsets[from + needle.length - 1];
      if (start !== undefined && end !== undefined) {
        matches.push({ from: start, to: end + 1 });
      }
      from = haystack.indexOf(needle, from + Math.max(1, needle.length));
    }
    return false;
  });
  return matches;
}

function decorate(doc: PMNode, matches: Match[], current: number): DecorationSet {
  return DecorationSet.create(
    doc,
    matches.map((match, index) =>
      Decoration.inline(match.from, match.to, { class: index === current ? "search-hit search-current" : "search-hit" }),
    ),
  );
}

const EMPTY: SearchState = { query: "", matches: [], current: -1, decorations: DecorationSet.empty };

export function searchPlugin(): Plugin<SearchState> {
  return new Plugin<SearchState>({
    key: searchKey,
    state: {
      init: () => EMPTY,
      apply(tr, previous) {
        const meta = tr.getMeta(searchKey) as { query: string; current?: number } | undefined;
        if (meta !== undefined) {
          if (meta.query.length === 0) {
            return EMPTY;
          }
          const matches = meta.query === previous.query && !tr.docChanged ? previous.matches : findMatches(tr.doc, meta.query);
          const current = matches.length === 0 ? -1 : Math.min(Math.max(meta.current ?? 0, 0), matches.length - 1);
          return { query: meta.query, matches, current, decorations: decorate(tr.doc, matches, current) };
        }
        if (tr.docChanged && previous.query.length > 0) {
          const matches = findMatches(tr.doc, previous.query);
          const current = Math.min(previous.current, matches.length - 1);
          return { ...previous, matches, current, decorations: decorate(tr.doc, matches, current) };
        }
        return previous;
      },
    },
    props: {
      decorations(state) {
        return searchKey.getState(state)?.decorations ?? null;
      },
    },
  });
}

export function searchState(state: EditorState): SearchState {
  return searchKey.getState(state) ?? EMPTY;
}

/** Lance ou affine la recherche ; place l'occurrence la plus proche du curseur. */
export function setQuery(view: EditorView, query: string): void {
  const matches = findMatches(view.state.doc, query);
  const head = view.state.selection.from;
  const nearest = Math.max(0, matches.findIndex((match) => match.from >= head));
  view.dispatch(view.state.tr.setMeta(searchKey, { query, current: nearest }).setMeta("addToHistory", false));
  reveal(view);
}

export function step(view: EditorView, direction: 1 | -1): void {
  const current = searchState(view.state);
  if (current.matches.length === 0) {
    return;
  }
  const next = (current.current + direction + current.matches.length) % current.matches.length;
  view.dispatch(view.state.tr.setMeta(searchKey, { query: current.query, current: next }).setMeta("addToHistory", false));
  reveal(view);
}

function reveal(view: EditorView): void {
  const current = searchState(view.state);
  const match = current.matches[current.current];
  if (match === undefined) {
    return;
  }
  const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, match.from, match.to)).scrollIntoView();
  view.dispatch(tr.setMeta("addToHistory", false));
}

/** Échap : on ferme en laissant le curseur sur l'occurrence. */
export function closeSearch(view: EditorView): void {
  view.dispatch(view.state.tr.setMeta(searchKey, { query: "" }).setMeta("addToHistory", false));
}
