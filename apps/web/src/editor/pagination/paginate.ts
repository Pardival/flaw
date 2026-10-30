import type { Node as PMNode } from "prosemirror-model";
import type { Transaction } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

import type { Geometry } from "./geometry.ts";
import { countBlocks, totalWords, updateCounts } from "./words.ts";

/** Folio affiché. « … » tant que le chapitre n'est pas mesuré (D-037). */
export type Folio = number | "…";

export type PageBreak = {
  pos: number;
  folio: Folio;
  /** Blanc ajouté en bas de la page précédente pour qu'elle soit pleine (pagination mesurée). */
  fill?: number;
};

export type ChapterModel = {
  index: number;
  title: string;
  blockStart: number;
  blockEnd: number;
  from: number;
  to: number;
  words: number;
  status: "estimated" | "measured";
  pages: PageBreak[];
};

export type PaginationModel = {
  bookTitle: string;
  counts: number[];
  chapters: ChapterModel[];
  decorations: DecorationSet;
  dirtyChapter: number | null;
  geometry: Geometry;
};

function bookTitleOf(doc: PMNode): string {
  let title = "";
  doc.forEach((node) => {
    if (title.length === 0 && node.type.name === "title") title = node.textContent;
  });
  return title;
}

function sumWords(counts: readonly number[], start: number, end: number): number {
  let total = 0;
  for (let index = start; index < end; index += 1) total += counts[index] ?? 0;
  return total;
}

function estimatedPages(words: number, geometry: Geometry): number {
  return Math.max(1, Math.ceil(words / geometry.wordsPerPage));
}

type ChapterSpan = {
  title: string;
  blockStart: number;
  blockEnd: number;
  from: number;
  to: number;
};

/** Le contenu avant le premier chapitre (ou tout le texte hors roman) forme une section sans titre. */
function chapterSpans(doc: PMNode): ChapterSpan[] {
  const spans: ChapterSpan[] = [];
  let current: ChapterSpan | null =
    doc.childCount > 0 && doc.child(0).type.name !== "chapter_title"
      ? { title: "", blockStart: 0, blockEnd: doc.childCount, from: 0, to: doc.content.size }
      : null;
  doc.forEach((node, offset, index) => {
    if (node.type.name !== "chapter_title") return;
    if (current !== null) {
      current.blockEnd = index;
      current.to = offset;
      spans.push(current);
    }
    current = {
      title: node.textContent,
      blockStart: index,
      blockEnd: doc.childCount,
      from: offset,
      to: doc.content.size,
    };
  });
  if (current !== null) spans.push(current);
  return spans;
}

/**
 * Saut de page : pied de la page précédente (folio), espace du bureau, haut de la
 * page suivante (titre courant en en-tête, sauf en ouverture de chapitre).
 */
function widget(pos: number, folio: Folio, layout: "pending" | "ready", key: string, head: string, opening: boolean, fill = 0) {
  return Decoration.widget(
    pos,
    () => {
      const element = document.createElement("div");
      element.className = "flaw-page-break";
      element.setAttribute("data-layout", layout);
      element.setAttribute("data-first", pos === 0 ? "true" : "false");
      element.setAttribute("contenteditable", "false");
      element.setAttribute("aria-hidden", "true");
      if (fill > 0) {
        const blank = document.createElement("span");
        blank.className = "flaw-fill";
        blank.style.height = `${String(fill)}px`;
        element.append(blank);
      }
      const previous = document.createElement("span");
      previous.className = "flaw-folio";
      previous.textContent = folio === "…" ? "…" : folio > 1 ? String(folio - 1) : "";
      const gap = document.createElement("span");
      gap.className = "flaw-gap";
      const running = document.createElement("span");
      running.className = "flaw-running-head";
      running.textContent = opening ? "" : head;
      element.append(previous, gap, running);
      return element;
    },
    { side: -1, ignoreSelection: true, key: `${key}-${head}-${String(fill)}` },
  );
}

function decorationsFor(doc: PMNode, chapters: readonly ChapterModel[]): DecorationSet {
  const widgets = [];
  for (const chapter of chapters) {
    if (chapter.status !== "measured") {
      widgets.push(widget(chapter.from, "…", "pending", `est-${chapter.index}`, chapter.title, true));
      continue;
    }
    for (const [order, page] of chapter.pages.entries()) {
      widgets.push(
        widget(page.pos, page.folio, "ready", `p-${chapter.index}-${page.pos}-${String(page.folio)}`, chapter.title, order === 0, page.fill),
      );
    }
  }
  return DecorationSet.create(doc, widgets);
}

function blockHeight(node: PMNode, geometry: Geometry): number {
  if (node.type.name === "scene_break") return geometry.lineHeightPx;
  const words = node.textContent.trim().length === 0 ? 0 : node.textContent.trim().split(/\s+/).length;
  const lines =
    node.type.name === "chapter_title"
      ? Math.max(2, Math.ceil(words / geometry.wordsPerLine))
      : Math.max(1, Math.ceil(Math.max(words, 1) / geometry.wordsPerLine));
  return lines * geometry.lineHeightPx;
}

function pagesBefore(chapters: readonly ChapterModel[], index: number, geometry: Geometry): number {
  let pages = 0;
  for (const chapter of chapters) {
    if (chapter.index >= index) break;
    pages +=
      chapter.status === "measured" ? chapter.pages.length : estimatedPages(chapter.words, geometry);
  }
  return pages;
}

function measurePages(
  doc: PMNode,
  chapter: ChapterModel,
  chapters: readonly ChapterModel[],
  geometry: Geometry,
): PageBreak[] {
  let used = 0;
  let folio = pagesBefore(chapters, chapter.index, geometry) + 1;
  const pages: PageBreak[] = [{ pos: chapter.from, folio }];
  doc.nodesBetween(chapter.from, chapter.to, (node, pos) => {
    if (!node.isBlock || node.type === doc.type) return;
    if (pos < chapter.from || pos >= chapter.to) return false;
    const height = blockHeight(node, geometry);
    const overflow = used > 0 && used + height > geometry.contentHeightPx;
    if (pos !== chapter.from && overflow) {
      folio += 1;
      pages.push({ pos, folio });
      used = height;
      return false;
    }
    used += height;
    return false;
  });
  return pages;
}

function withWords(spans: readonly ChapterSpan[], counts: readonly number[], previous: readonly ChapterModel[]): ChapterModel[] {
  return spans.map((span, index) => {
    const prior = previous[index];
    const samePlace =
      prior !== undefined && prior.blockStart === span.blockStart && prior.title === span.title;
    return {
      index,
      title: span.title,
      blockStart: span.blockStart,
      blockEnd: span.blockEnd,
      from: span.from,
      to: span.to,
      words: sumWords(counts, span.blockStart, span.blockEnd),
      status: samePlace ? prior.status : "estimated",
      pages: samePlace ? prior.pages : [],
    };
  });
}

/** Décorations recalculées depuis des pages déjà connues (pagination mesurée). */
export function rebuildDecorations(doc: PMNode, chapters: readonly ChapterModel[]): DecorationSet {
  return decorationsFor(doc, chapters);
}

export function createModel(doc: PMNode, geometry: Geometry): PaginationModel {
  const counts = countBlocks(doc);
  const chapters = withWords(chapterSpans(doc), counts, []);
  return {
    bookTitle: bookTitleOf(doc),
    counts,
    chapters,
    decorations: decorationsFor(doc, chapters),
    dirtyChapter: chapters.length > 0 ? 0 : null,
    geometry,
  };
}

/** Mesure un chapitre. Les autres gardent leur état. Les lointains restent estimés. */
export function measureChapter(model: PaginationModel, doc: PMNode, index: number): PaginationModel {
  const chapter = model.chapters[index];
  if (chapter === undefined) return { ...model, dirtyChapter: null };
  const pages = measurePages(doc, chapter, model.chapters, model.geometry);
  const chapters = model.chapters.map((item, itemIndex) =>
    itemIndex === index ? { ...item, status: "measured" as const, pages } : item,
  );
  const dirtyChapter = model.dirtyChapter === index ? null : model.dirtyChapter;
  return {
    ...model,
    chapters,
    decorations: decorationsFor(doc, chapters),
    dirtyChapter,
  };
}

export function measureChapters(model: PaginationModel, doc: PMNode, indexes: readonly number[]): PaginationModel {
  let next = model;
  for (const index of indexes) next = measureChapter(next, doc, index);
  return next;
}

function chapterIndexAt(chapters: readonly ChapterModel[], pos: number): number | null {
  for (const chapter of chapters) {
    if (pos >= chapter.from && pos <= chapter.to) return chapter.index;
  }
  return chapters.length > 0 ? chapters.length - 1 : null;
}

/**
 * Chemin de frappe : mappe les décorations et le compteur du bloc touché.
 * Ne remet aucun chapitre en pages.
 */
function mapChapters(model: PaginationModel, tr: Transaction, counts: readonly number[]): ChapterModel[] {
  return model.chapters.map((chapter) => ({
    ...chapter,
    from: tr.mapping.map(chapter.from),
    to: tr.mapping.map(chapter.to, -1),
    words: sumWords(counts, chapter.blockStart, chapter.blockEnd),
    pages: chapter.pages.map((page) => ({ ...page, pos: tr.mapping.map(page.pos) })),
  }));
}

function rebuildChapters(model: PaginationModel, tr: Transaction, counts: readonly number[]): ChapterModel[] {
  const mapped = mapChapters(model, tr, model.counts);
  const used = new Set<number>();
  return chapterSpans(tr.doc).map((span, index) => {
    let prior: ChapterModel | undefined;
    for (let cursor = 0; cursor < mapped.length; cursor += 1) {
      const candidate = mapped[cursor];
      if (candidate === undefined || used.has(cursor)) continue;
      if (candidate.title.length > 0 && candidate.title === span.title) {
        prior = candidate;
        used.add(cursor);
        break;
      }
    }
    return {
      index,
      title: span.title,
      blockStart: span.blockStart,
      blockEnd: span.blockEnd,
      from: span.from,
      to: span.to,
      words: sumWords(counts, span.blockStart, span.blockEnd),
      status: prior?.status ?? "estimated",
      pages: prior?.pages ?? [],
    };
  });
}

export function integrate(model: PaginationModel, tr: Transaction): PaginationModel {
  const doc = tr.doc;
  const counts = updateCounts(tr.before, doc, model.counts);
  const structureSame = tr.before.childCount === doc.childCount;
  const chapters = structureSame ? mapChapters(model, tr, counts) : rebuildChapters(model, tr, counts);
  const dirtyChapter = chapterIndexAt(chapters, tr.selection.from);
  return {
    bookTitle: structureSame ? model.bookTitle : bookTitleOf(doc),
    counts,
    chapters,
    decorations: structureSame ? model.decorations.map(tr.mapping, doc) : decorationsFor(doc, chapters),
    dirtyChapter,
    geometry: model.geometry,
  };
}

/** Folio de la dernière page (affiché par l'éditeur, sans widget en fin de document). */
export function lastFolio(model: PaginationModel): Folio {
  const last = model.chapters[model.chapters.length - 1];
  if (last === undefined || last.status !== "measured") return "…";
  return last.pages[last.pages.length - 1]?.folio ?? "…";
}

export function runningHead(model: PaginationModel, pos: number): {
  bookTitle: string;
  chapterTitle: string;
  folio: Folio;
} {
  const index = chapterIndexAt(model.chapters, pos);
  const chapter = index === null ? undefined : model.chapters[index];
  if (chapter === undefined) {
    return { bookTitle: model.bookTitle, chapterTitle: "", folio: "…" };
  }
  if (chapter.status !== "measured") {
    return { bookTitle: model.bookTitle, chapterTitle: chapter.title, folio: "…" };
  }
  let folio: Folio = chapter.pages[0]?.folio ?? "…";
  for (const page of chapter.pages) {
    if (page.pos <= pos) folio = page.folio;
  }
  return { bookTitle: model.bookTitle, chapterTitle: chapter.title, folio };
}

export function textPositionNear(doc: PMNode, target: number): number {
  let found = 1;
  doc.descendants((node, pos) => {
    if (!node.isText || node.text === undefined) return;
    if (pos + node.text.length > target) {
      found = Math.min(pos + node.text.length, Math.max(pos + 1, target));
      return false;
    }
    found = pos + node.text.length;
  });
  return found;
}

export { totalWords };
