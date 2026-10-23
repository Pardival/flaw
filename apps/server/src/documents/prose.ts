/**
 * Document ProseMirror initial et projection (titre, extrait, plan).
 * Le JSON passe par documentFromJson (@flaw/schema) avant chaque écriture.
 */
import {
  DOCUMENT_PAGE_FORMAT,
  SCHEMA_VERSION,
  SCREENPLAY_DEFAULTS,
  documentFromJson,
  emptyDocument,
  schema,
} from "@flaw/schema/src/index.ts";
import type { ProseMirrorNode as PMNode } from "@flaw/schema/src/index.ts";

import type { DocumentMode, PageFormat } from "./schema.ts";

export type OutlineItem = { level: number; title: string };

export type Projection = {
  title: string;
  excerpt: string;
  outline: OutlineItem[];
  baseFontSizePt: number;
  schemaVersion: number;
};

export type Described = Projection & { wordCount: number; json: unknown };

const NOVEL_PAGE: PageFormat = "novel_13x20";
const DEFAULT_FONT = "EB Garamond";
const DEFAULT_SIZE = 11;

export function defaultsFor(mode: DocumentMode): { pageFormat: PageFormat; fontFamily: string; baseFontSizePt: number } {
  if (mode === "screenplay") {
    return {
      pageFormat: SCREENPLAY_DEFAULTS.pageFormat,
      fontFamily: SCREENPLAY_DEFAULTS.fontFamily,
      baseFontSizePt: SCREENPLAY_DEFAULTS.baseFontSizePt,
    };
  }
  if (mode === "novel") {
    return { pageFormat: NOVEL_PAGE, fontFamily: DEFAULT_FONT, baseFontSizePt: DEFAULT_SIZE };
  }
  return { pageFormat: DOCUMENT_PAGE_FORMAT, fontFamily: DEFAULT_FONT, baseFontSizePt: DEFAULT_SIZE };
}

function titleNode(title: string): PMNode {
  const text = title.length > 0 ? [schema.text(title)] : [];
  return schema.node("title", { align: null }, text);
}

export function titledDocument(mode: DocumentMode, title: string): PMNode {
  const base = emptyDocument(mode);
  const blocks: PMNode[] = [titleNode(title)];
  base.forEach((node) => {
    blocks.push(node);
  });
  return documentFromJson(schema.node("doc", null, blocks).toJSON());
}

export function replaceTitle(doc: PMNode, title: string): PMNode {
  const blocks: PMNode[] = [titleNode(title)];
  let skipped = false;
  doc.forEach((node) => {
    if (!skipped && node.type.name === "title") {
      skipped = true;
      return;
    }
    blocks.push(node);
  });
  return documentFromJson(schema.node("doc", null, blocks).toJSON());
}

export function readDocument(value: unknown): PMNode {
  return documentFromJson(value);
}

function plain(node: PMNode): string {
  if (node.isText) {
    return node.text ?? "";
  }
  let text = "";
  node.descendants((child) => {
    if (child.isText) {
      text += child.text ?? "";
    }
  });
  return text;
}

export function describeDocument(doc: PMNode, baseFontSizePt: number): Described {
  let title = "";
  let sawTitle = false;
  const parts: string[] = [];
  const outline: OutlineItem[] = [];
  doc.forEach((block) => {
    const name = block.type.name;
    const text = plain(block).replace(/\s+/gu, " ").trim();
    if (name === "title" && !sawTitle) {
      sawTitle = true;
      title = text;
      return;
    }
    if (text.length > 0 && (name === "chapter_title" || name === "scene_heading")) {
      outline.push({ level: 1, title: text });
    } else if (text.length > 0 && name === "heading") {
      const level = block.attrs.level;
      outline.push({ level: level === 2 || level === 3 ? level : 1, title: text });
    }
    if (text.length > 0) {
      parts.push(text);
    }
  });
  const body = parts.join("\n");
  const wordCount = body.trim().length === 0 ? 0 : body.trim().split(/\s+/u).length;
  return {
    title,
    excerpt: body.slice(0, 200),
    outline,
    baseFontSizePt,
    schemaVersion: SCHEMA_VERSION,
    wordCount,
    json: doc.toJSON(),
  };
}

export function documentPlainText(doc: PMNode): string {
  const parts: string[] = [];
  doc.forEach((block) => {
    const text = plain(block).trim();
    if (text.length > 0) {
      parts.push(text);
    }
  });
  return parts.join("\n\n");
}

export function documentMarkdown(doc: PMNode): string {
  const lines: string[] = [];
  doc.forEach((block) => {
    const name = block.type.name;
    const text = plain(block).trim();
    if (name === "scene_break") {
      lines.push("---");
      return;
    }
    if (text.length === 0) {
      return;
    }
    if (name === "title" || name === "chapter_title") {
      lines.push(`# ${text}`);
      return;
    }
    if (name === "heading") {
      const level = block.attrs.level === 2 ? 2 : block.attrs.level === 3 ? 3 : 1;
      lines.push(`${"#".repeat(level)} ${text}`);
      return;
    }
    if (name === "scene_heading") {
      lines.push(`## ${text}`);
      return;
    }
    lines.push(text);
  });
  return lines.join("\n\n");
}

export function isProjection(value: unknown): value is Projection {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.title === "string" && typeof record.excerpt === "string" && Array.isArray(record.outline);
}
