import { parseFragment } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";
import { Mark } from "prosemirror-model";
import type { Node as PMNode } from "prosemirror-model";

import { readAlign, readFontSize } from "./attrs.ts";
import { isTextBlockName, type Align } from "./constants.ts";
import { SchemaError } from "./errors.ts";
import { validateDocument } from "./document.ts";
import { schema } from "./schema.ts";

/**
 * Collage HTML filtré par le schéma (SEC-WEB-06).
 * Les éléments dangereux sont retirés avec leur contenu.
 * Les attributs `style`, `on*`, `href` et `src` ne sont pas lus.
 * Seuls les nœuds et les marques du schéma sont produits.
 */

const HTML_NS = "http://www.w3.org/1999/xhtml";

const DROP_TAGS = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "applet",
  "link",
  "meta",
  "base",
  "noscript",
  "noembed",
  "noframes",
  "template",
  "svg",
  "math",
  "img",
  "image",
  "picture",
  "source",
  "video",
  "audio",
  "canvas",
  "frame",
  "frameset",
  "portal",
  "textarea",
  "input",
  "select",
  "option",
  "optgroup",
  "keygen",
  "param",
  "track",
  "map",
  "area",
  "xml",
  "foreignobject",
]);

const INLINE_TAGS = new Set([
  "a",
  "abbr",
  "b",
  "bdi",
  "bdo",
  "button",
  "cite",
  "code",
  "data",
  "del",
  "dfn",
  "em",
  "font",
  "i",
  "ins",
  "kbd",
  "label",
  "mark",
  "q",
  "s",
  "samp",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "time",
  "u",
  "var",
  "wbr",
]);

type PChild = DefaultTreeAdapterTypes.ChildNode;
type PElement = DefaultTreeAdapterTypes.Element;
type PText = DefaultTreeAdapterTypes.TextNode;

type InlinePiece =
  | { type: "text"; text: string; marks: readonly Mark[] }
  | { type: "break"; marks: readonly Mark[] };

function isElement(node: PChild): node is PElement {
  return node.nodeName !== "#text" && node.nodeName !== "#comment" && node.nodeName !== "#documentType";
}

function isText(node: PChild): node is PText {
  return node.nodeName === "#text";
}

function isDropped(element: PElement): boolean {
  return DROP_TAGS.has(element.tagName) || element.namespaceURI !== HTML_NS;
}

function attr(element: PElement, name: string): string | null {
  for (const item of element.attrs) {
    if (item.name === name) return item.value;
  }
  return null;
}

function readAlignAttr(element: PElement): Align | null {
  const fromData = readAlign(attr(element, "data-align"));
  if (fromData !== null) return fromData;
  return readAlign(attr(element, "align"));
}

function headingLevel(element: PElement): 1 | 2 | 3 {
  const fromData = attr(element, "data-level");
  if (fromData === "1" || fromData === "2" || fromData === "3") {
    return Number(fromData) as 1 | 2 | 3;
  }
  if (element.tagName === "h2") return 2;
  if (element.tagName === "h1") return 1;
  if (/^h[3-6]$/.test(element.tagName)) return 3;
  return 1;
}

function isHeadingTag(tag: string): boolean {
  return /^h[1-6]$/.test(tag);
}

function flawName(element: PElement): string | null {
  const value = attr(element, "data-flaw-node");
  if (value !== null && isTextBlockName(value)) return value;
  return null;
}

function withMark(marks: readonly Mark[], mark: Mark): readonly Mark[] {
  return Mark.setFrom([...marks.filter((item) => item.type !== mark.type), mark]);
}

function addMark(tag: string, element: PElement, marks: readonly Mark[]): readonly Mark[] {
  if (tag === "strong" || tag === "b") return withMark(marks, schema.marks.bold.create());
  if (tag === "em" || tag === "i") return withMark(marks, schema.marks.italic.create());
  if (tag === "span") {
    const pt = readFontSize(attr(element, "data-font-size"));
    if (pt === null) return marks;
    return withMark(marks, schema.marks.font_size.create({ pt }));
  }
  return marks;
}

function pushText(pieces: InlinePiece[], text: string, marks: readonly Mark[]): void {
  if (text.length === 0) return;
  const last = pieces.at(-1);
  if (last?.type === "text" && Mark.sameSet(last.marks, marks)) {
    last.text += text;
    return;
  }
  pieces.push({ type: "text", text, marks });
}

function pushBrokenText(pieces: InlinePiece[], text: string, marks: readonly Mark[]): void {
  const parts = text.replace(/\r\n?/g, "\n").split("\n");
  parts.forEach((part, index) => {
    if (index > 0) pieces.push({ type: "break", marks });
    pushText(pieces, part, marks);
  });
}

function trimEdges(pieces: readonly InlinePiece[]): InlinePiece[] {
  const next = pieces.map((piece) =>
    piece.type === "text" ? { type: "text" as const, text: piece.text, marks: piece.marks } : piece,
  );
  for (const piece of next) {
    if (piece.type !== "text") break;
    piece.text = piece.text.replace(/^\s+/, "");
    if (piece.text.length > 0) break;
  }
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const piece = next[index];
    if (piece === undefined || piece.type !== "text") break;
    piece.text = piece.text.replace(/\s+$/, "");
    if (piece.text.length > 0) break;
  }
  return next.filter((piece) => piece.type !== "text" || piece.text.length > 0);
}

function inlineNodes(pieces: readonly InlinePiece[]): PMNode[] {
  const nodes: PMNode[] = [];
  for (const piece of pieces) {
    if (piece.type === "break") {
      nodes.push(schema.node("hard_break", null, undefined, piece.marks));
      continue;
    }
    if (piece.text.length === 0) continue;
    nodes.push(schema.text(piece.text, piece.marks));
  }
  return nodes;
}

function makeParagraph(pieces: readonly InlinePiece[], align: Align | null, trim: boolean): PMNode {
  const normalized = trim
    ? trimEdges(pieces)
    : pieces.filter((piece) => piece.type !== "text" || piece.text.length > 0);
  return schema.node("paragraph", { align }, inlineNodes(normalized));
}

function parseInlines(nodes: readonly PChild[], marks: readonly Mark[], breaks: boolean): InlinePiece[] {
  const pieces: InlinePiece[] = [];
  for (const node of nodes) {
    if (isText(node)) {
      if (breaks) pushBrokenText(pieces, node.value, marks);
      else pushText(pieces, node.value, marks);
      continue;
    }
    if (!isElement(node) || isDropped(node)) continue;
    const tag = node.tagName;
    const next = addMark(tag, node, marks);
    if (tag === "br") {
      pieces.push({ type: "break", marks: next });
      continue;
    }
    pieces.push(...parseInlines(node.childNodes, next, breaks || tag === "pre"));
  }
  return pieces;
}

function makeHeading(element: PElement, marks: readonly Mark[]): PMNode {
  const pieces = parseInlines(element.childNodes, marks, false);
  return schema.node(
    "heading",
    { level: headingLevel(element), align: readAlignAttr(element) },
    inlineNodes(trimEdges(pieces)),
  );
}

function makeTextBlock(element: PElement, marks: readonly Mark[]): PMNode {
  const name = flawName(element) ?? "paragraph";
  const pieces = parseInlines(element.childNodes, marks, false);
  const content = inlineNodes(trimEdges(pieces));
  if (name === "heading") {
    return schema.node("heading", { level: headingLevel(element), align: readAlignAttr(element) }, content);
  }
  return schema.node(name, { align: readAlignAttr(element) }, content);
}

function parseChildren(nodes: readonly PChild[], marks: readonly Mark[]): PMNode[] {
  const blocks: PMNode[] = [];
  let inlines: InlinePiece[] = [];

  const flush = (): void => {
    const paragraph = makeParagraph(inlines, null, true);
    inlines = [];
    if (paragraph.content.size > 0) blocks.push(paragraph);
  };

  for (const child of nodes) {
    if (isText(child)) {
      pushText(inlines, child.value, marks);
      continue;
    }
    if (!isElement(child) || isDropped(child)) continue;
    const tag = child.tagName;
    if (tag === "br" || INLINE_TAGS.has(tag)) {
      inlines.push(...parseInlines([child], marks, false));
      continue;
    }
    if (tag === "ul" || tag === "ol") {
      flush();
      const list = parseList(child, 0);
      if (list) blocks.push(list);
      continue;
    }
    if (tag === "hr") {
      flush();
      blocks.push(schema.node("scene_break"));
      continue;
    }
    if (isHeadingTag(tag)) {
      flush();
      blocks.push(makeHeading(child, marks));
      continue;
    }
    if (tag === "p" || flawName(child) !== null) {
      flush();
      blocks.push(makeTextBlock(child, marks));
      continue;
    }
    if (tag === "pre") {
      flush();
      const paragraph = makeParagraph(parseInlines(child.childNodes, marks, true), null, false);
      if (paragraph.content.size > 0) blocks.push(paragraph);
      continue;
    }
    flush();
    blocks.push(...parseChildren(child.childNodes, addMark(tag, child, marks)));
  }
  flush();
  return blocks;
}

function absorbItem(
  nodes: readonly PChild[],
  depth: number,
): { paragraphs: PMNode[]; nested: PMNode | null } {
  const paragraphs: PMNode[] = [];
  let inlines: InlinePiece[] = [];
  let nested: PMNode | null = null;

  const flush = (): void => {
    const paragraph = makeParagraph(inlines, null, true);
    inlines = [];
    if (paragraph.content.size > 0) paragraphs.push(paragraph);
  };

  for (const child of nodes) {
    if (isText(child)) {
      pushText(inlines, child.value, Mark.none);
      continue;
    }
    if (!isElement(child) || isDropped(child)) continue;
    const tag = child.tagName;
    if (tag === "br" || INLINE_TAGS.has(tag)) {
      inlines.push(...parseInlines([child], Mark.none, false));
      continue;
    }
    if (tag === "ul" || tag === "ol") {
      flush();
      if (depth >= 1 || nested !== null) {
        paragraphs.push(...flattenList(child));
      } else {
        const list = parseList(child, depth + 1);
        if (list) nested = list;
      }
      continue;
    }
    if (tag === "p" || isHeadingTag(tag) || flawName(child) !== null) {
      flush();
      const pieces = parseInlines(child.childNodes, Mark.none, false);
      paragraphs.push(makeParagraph(pieces, tag === "p" ? readAlignAttr(child) : null, true));
      continue;
    }
    if (tag === "hr") {
      flush();
      continue;
    }
    flush();
    const inner = absorbItem(child.childNodes, depth);
    paragraphs.push(...inner.paragraphs);
    if (inner.nested === null) continue;
    if (depth >= 1 || nested !== null) paragraphs.push(...paragraphsIn(inner.nested));
    else nested = inner.nested;
  }
  flush();
  return { paragraphs, nested };
}

function paragraphsIn(node: PMNode): PMNode[] {
  if (node.type === schema.nodes.paragraph) return [node];
  const paragraphs: PMNode[] = [];
  node.forEach((child) => {
    paragraphs.push(...paragraphsIn(child));
  });
  return paragraphs;
}

function flattenList(element: PElement): PMNode[] {
  const paragraphs: PMNode[] = [];
  for (const child of element.childNodes) {
    if (!isElement(child) || isDropped(child) || child.tagName !== "li") continue;
    const absorbed = absorbItem(child.childNodes, 1);
    paragraphs.push(...absorbed.paragraphs);
  }
  return paragraphs;
}

function parseList(element: PElement, depth: number): PMNode | null {
  if (depth > 1) return null;
  const ordered = element.tagName === "ol";
  const listName =
    depth === 0 ? (ordered ? "ordered_list" : "bullet_list") : ordered ? "ordered_list_2" : "bullet_list_2";
  const itemName = depth === 0 ? "list_item" : "list_item_2";
  const items: PMNode[] = [];
  for (const child of element.childNodes) {
    if (!isElement(child) || isDropped(child) || child.tagName !== "li") continue;
    items.push(parseListItem(child, depth, itemName));
  }
  if (items.length === 0) return null;
  return schema.node(listName, null, items);
}

function parseListItem(element: PElement, depth: number, itemName: string): PMNode {
  const absorbed = absorbItem(element.childNodes, depth);
  const paragraphs = absorbed.paragraphs.length > 0 ? absorbed.paragraphs : [schema.node("paragraph")];
  if (itemName === "list_item" && absorbed.nested) {
    return schema.node(itemName, null, [...paragraphs, absorbed.nested]);
  }
  return schema.node(itemName, null, paragraphs);
}

/** Convertit un fragment HTML en document. Le résultat ne contient que le schéma. */
export function parsePastedHtml(html: string): PMNode {
  if (typeof html !== "string") throw new SchemaError("invalid_json");
  const fragment = parseFragment(html);
  const blocks = parseChildren(fragment.childNodes, Mark.none);
  const doc = schema.node("doc", null, blocks.length > 0 ? blocks : [schema.node("paragraph")]);
  validateDocument(doc);
  return doc;
}
