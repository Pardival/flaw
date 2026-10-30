import type { Node as PMNode } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";

import { rebuildDecorations, type ChapterModel, type PageBreak, type PaginationModel } from "./paginate.ts";

/**
 * Pagination mesurée (écrans tablette et ordinateur) : une copie du texte, sans sauts de
 * page, est mise en page hors écran ; chaque page s'arrête à la première ligne qui dépasse,
 * au besoin au milieu d'un paragraphe, et le reste de la page est comblé jusqu'au folio.
 */

type Segment = { node: Text | HTMLBRElement; start: number; length: number };

/** Segments de texte d'un bloc, dans l'ordre des positions ProseMirror (un saut de ligne = 1). */
function segmentsOf(block: HTMLElement): Segment[] {
  const segments: Segment[] = [];
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let offset = 0;
  for (let current = walker.nextNode(); current !== null; current = walker.nextNode()) {
    if (current instanceof Text) {
      const length = current.data.length;
      if (length > 0) {
        segments.push({ node: current, start: offset, length });
        offset += length;
      }
    } else if (current instanceof HTMLBRElement && !current.classList.contains("ProseMirror-trailingBreak")) {
      segments.push({ node: current, start: offset, length: 1 });
      offset += 1;
    }
  }
  return segments;
}

function charAt(segments: readonly Segment[], offset: number): string {
  for (const segment of segments) {
    if (offset >= segment.start && offset < segment.start + segment.length) {
      return segment.node instanceof Text ? (segment.node.data[offset - segment.start] ?? "") : "\n";
    }
  }
  return "";
}

/** Reproduit la coupure dans la copie : la suite du paragraphe se recompose comme dans le texte réel. */
function markCut(segments: readonly Segment[], offset: number): void {
  const segment = segments.find((item) => offset >= item.start && offset < item.start + item.length);
  if (segment === undefined || !(segment.node instanceof Text)) return;
  const marker = document.createElement("div");
  marker.className = "flaw-cut";
  const range = document.createRange();
  range.setStart(segment.node, offset - segment.start);
  range.insertNode(marker);
}

function charRect(segments: readonly Segment[], offset: number, range: Range): DOMRect | null {
  let low = 0;
  let high = segments.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const segment = segments[middle];
    if (segment === undefined) return null;
    if (offset < segment.start) high = middle - 1;
    else if (offset >= segment.start + segment.length) low = middle + 1;
    else {
      if (segment.node instanceof HTMLBRElement) {
        range.selectNode(segment.node);
      } else {
        range.setStart(segment.node, offset - segment.start);
        range.setEnd(segment.node, offset - segment.start + 1);
      }
      return range.getBoundingClientRect();
    }
  }
  return null;
}

type Cut = { pos: number; lineTop: number };

/**
 * Coupe dans un bloc de texte : première ligne dont le bas dépasse `boundary`.
 * null si le bloc ne se coupe pas (structure, ou la première ligne dépasse déjà).
 */
function cutInside(node: PMNode, element: HTMLElement, blockPos: number, boundary: number, origin: number, lineGap: number): Cut | null {
  if (!node.isTextblock) return null;
  const segments = segmentsOf(element);
  const total = segments.reduce((sum, segment) => sum + segment.length, 0);
  if (total === 0 || total !== node.content.size) return null;
  const range = document.createRange();
  let low = 0;
  let high = total;
  while (low < high) {
    const middle = (low + high) >> 1;
    const rect = charRect(segments, middle, range);
    if (rect !== null && rect.bottom - origin > boundary) high = middle;
    else low = middle + 1;
  }
  if (low <= 0 || low >= total) return null;
  // Jamais au milieu d'un mot (césure) : le mot entier passe à la page suivante.
  while (low > 0 && !/\s/u.test(charAt(segments, low - 1))) low -= 1;
  if (low <= 0) return null;
  markCut(segments, low);
  const rect = charRect(segmentsOf(element), low, range);
  if (rect === null) return null;
  return { pos: blockPos + 1 + low, lineTop: rect.top - origin - lineGap };
}

/** Copie mesurable du texte : mêmes styles, sans sauts de page ni masquage hors écran. */
function measuringCopy(view: EditorView): HTMLElement | null {
  const source = view.dom;
  const host = source.parentElement;
  if (host === null) return null;
  const copy = source.cloneNode(true) as HTMLElement;
  for (const widget of copy.querySelectorAll(".flaw-page-break")) widget.remove();
  copy.removeAttribute("contenteditable");
  copy.classList.add("flaw-measure");
  copy.setAttribute("aria-hidden", "true");
  // Largeur exacte (fractions comprises) : un pixel de moins suffit à couper une ligne plus tôt.
  copy.style.width = `${String(source.getBoundingClientRect().width)}px`;
  host.append(copy);
  return copy;
}

type Found = { pos: number; fill: number; opening: boolean };

export function measureFromDom(view: EditorView, model: PaginationModel): PaginationModel | null {
  const book = view.dom.closest<HTMLElement>(".book");
  if (book === null) return null;
  const scale = parseFloat(getComputedStyle(book).getPropertyValue("--book-scale")) || 1;
  const pageContent = model.geometry.contentHeightPx * scale;
  const doc = view.state.doc;
  const copy = measuringCopy(view);
  if (copy === null) return null;
  try {
    const blocks = [...copy.children] as HTMLElement[];
    if (blocks.length !== doc.childCount) return null;
    // Même origine que le texte réel : la marge du premier bloc n'y traverse pas la copie
    // (positionnée en absolu), alors qu'elle sort du texte réel.
    const realFirst = [...view.dom.children].find((child) => !child.classList.contains("flaw-page-break"));
    const firstTop = blocks[0]?.getBoundingClientRect().top ?? copy.getBoundingClientRect().top;
    const origin =
      realFirst === undefined
        ? copy.getBoundingClientRect().top
        : firstTop - (realFirst.getBoundingClientRect().top - view.dom.getBoundingClientRect().top);
    const lineHeight = parseFloat(getComputedStyle(copy).lineHeight) || 0;
    // Lus à la demande : une coupure reproduite dans la copie déplace les blocs suivants.
    const tops = { at: (index: number) => (blocks[index]?.getBoundingClientRect().top ?? origin) - origin };
    const bottoms = { at: (index: number) => (blocks[index]?.getBoundingClientRect().bottom ?? origin) - origin };
    const positions: number[] = [];
    doc.forEach((_node, offset) => positions.push(offset));

    const found: Found[][] = model.chapters.map(() => []);
    let pageTop = 0;
    for (const chapter of model.chapters) {
      const list = found[chapter.index];
      if (list === undefined) continue;
      // Chaque chapitre ouvre une page.
      if (chapter.blockStart > 0) {
        const top = tops.at(chapter.blockStart);
        list.push({ pos: chapter.from, fill: Math.max(0, pageTop + pageContent - top), opening: true });
        pageTop = top;
      } else {
        list.push({ pos: chapter.from, fill: 0, opening: true });
      }
      let block = chapter.blockStart;
      let lastPos = chapter.from;
      while (block < chapter.blockEnd) {
        const boundary = pageTop + pageContent;
        while (block < chapter.blockEnd && bottoms.at(block) <= boundary) block += 1;
        if (block >= chapter.blockEnd) break;
        const element = blocks[block];
        const node = doc.child(block);
        const blockTop = tops.at(block);
        let cut: Cut | null = null;
        if (element !== undefined && blockTop < boundary - 1) {
          const half = Math.max(0, (lineHeight - parseFloat(getComputedStyle(element).fontSize) * 1.2) / 2);
          cut = cutInside(node, element, positions[block] ?? 0, boundary, origin, half);
        }
        if (cut === null) {
          // Le bloc commence la page suivante ; un bloc plus haut qu'une page passe tel quel.
          const start = blockTop > pageTop + 1 ? blockTop : boundary;
          cut = { pos: positions[block] ?? 0, lineTop: Math.min(start, boundary) };
          if (block === chapter.blockStart) {
            pageTop = boundary;
            block += 1;
            continue;
          }
        }
        if (cut.pos <= lastPos) {
          // Bloc insécable plus haut qu'une page : il déborde, on mesure la suite.
          pageTop = boundary;
          continue;
        }
        lastPos = cut.pos;
        const lineTop = cut.lineTop > pageTop + 1 ? cut.lineTop : boundary;
        list.push({ pos: cut.pos, fill: Math.max(0, boundary - lineTop), opening: false });
        pageTop = lineTop;
        if (cut.pos === positions[block]) {
          // Coupe avant le bloc : il est mesuré depuis le haut de la nouvelle page.
          continue;
        }
      }
    }

    let folio = 0;
    const chapters: ChapterModel[] = model.chapters.map((chapter) => {
      const pages: PageBreak[] = (found[chapter.index] ?? []).map((page) => {
        folio += 1;
        return { pos: page.pos, folio, fill: Math.round(page.fill) };
      });
      return { ...chapter, status: "measured" as const, pages };
    });
    return { ...model, chapters, decorations: rebuildDecorations(doc, chapters), dirtyChapter: null };
  } finally {
    copy.remove();
  }
}
