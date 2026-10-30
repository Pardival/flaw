import type { Node as PMNode } from "prosemirror-model";

import { assertAlign, assertAlt, assertImageAlign, assertAssetId, assertCrop, assertFontSize, assertImageRatio, assertImageWidth, assertLevel } from "./attrs.ts";
import {
  COMMON_NODES,
  MODE_NODES,
  isDocumentMode,
  type DocumentMode,
} from "./constants.ts";
import { SchemaError } from "./errors.ts";
import { schema } from "./schema.ts";

const NODE_KEYS = new Set(["type", "attrs", "content", "marks", "text"]);
const MARK_KEYS = new Set(["type", "attrs"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertAttrValue(key: string, value: unknown, typeName: string): void {
  if (typeName === "image") {
    if (key === "asset") assertAssetId(value, false);
    else if (key === "original") assertAssetId(value, true);
    else if (key === "width") assertImageWidth(value);
    else if (key === "ratio") assertImageRatio(value);
    else if (key === "align") assertImageAlign(value);
    else if (key === "crop") assertCrop(value);
    else if (key === "alt") assertAlt(value);
    else throw new SchemaError("unknown_attr");
    return;
  }
  if (key === "align") {
    assertAlign(value);
    return;
  }
  if (key === "level") {
    assertLevel(value);
    return;
  }
  if (key === "pt") {
    assertFontSize(value);
    return;
  }
  throw new SchemaError("unknown_attr");
}

function assertAttrs(typeName: string, value: unknown, mark: boolean): void {
  const owner = mark ? schema.marks[typeName] : schema.nodes[typeName];
  const defined = owner?.spec.attrs ?? {};
  const given = value === undefined || value === null ? {} : value;
  if (!isRecord(given)) throw new SchemaError("invalid_json");
  for (const key of Object.keys(given)) {
    if (!Object.hasOwn(defined, key)) throw new SchemaError("unknown_attr");
    assertAttrValue(key, given[key], typeName);
  }
  for (const key of Object.keys(defined)) {
    const spec = defined[key];
    if (spec !== undefined && !Object.hasOwn(given, key) && !("default" in spec)) {
      throw new SchemaError("invalid_attr");
    }
  }
}

function assertMarks(value: unknown, allowed: boolean): void {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) throw new SchemaError("invalid_json");
  if (!allowed && value.length > 0) throw new SchemaError("invalid_content");
  const seen = new Set<string>();
  for (const mark of value) {
    if (!isRecord(mark)) throw new SchemaError("invalid_json");
    for (const key of Object.keys(mark)) {
      if (!MARK_KEYS.has(key)) throw new SchemaError("invalid_json");
    }
    if (typeof mark.type !== "string") throw new SchemaError("invalid_json");
    if (schema.marks[mark.type] === undefined) throw new SchemaError("unknown_mark");
    if (seen.has(mark.type)) throw new SchemaError("invalid_content");
    seen.add(mark.type);
    assertAttrs(mark.type, mark.attrs, true);
  }
}

function assertJsonNode(value: unknown, root: boolean): void {
  if (!isRecord(value)) throw new SchemaError("invalid_json");
  for (const key of Object.keys(value)) {
    if (!NODE_KEYS.has(key)) throw new SchemaError("invalid_json");
  }
  if (typeof value.type !== "string") throw new SchemaError("invalid_json");
  const nodeType = schema.nodes[value.type];
  if (nodeType === undefined) throw new SchemaError("unknown_node");
  if (root && value.type !== "doc") throw new SchemaError("invalid_json");
  if (!root && value.type === "doc") throw new SchemaError("invalid_content");

  if (value.type === "text") {
    if (typeof value.text !== "string" || value.text.length === 0) {
      throw new SchemaError("invalid_content");
    }
    if (value.content !== undefined && value.content !== null) {
      throw new SchemaError("invalid_json");
    }
  } else if (value.text !== undefined) {
    throw new SchemaError("invalid_json");
  }

  assertAttrs(value.type, value.attrs, false);
  const inline = value.type === "text" || value.type === "hard_break";
  assertMarks(value.marks, inline);
  if (value.type === "text") return;

  if (value.content === undefined || value.content === null) return;
  if (!Array.isArray(value.content)) throw new SchemaError("invalid_json");
  if (nodeType.isLeaf && value.content.length > 0) throw new SchemaError("invalid_content");
  for (const child of value.content) assertJsonNode(child, false);
}

/** Vérifie qu'un nœud déjà construit respecte le schéma, y compris les attributs. */
export function validateDocument(doc: PMNode): void {
  if (doc.type !== schema.nodes.doc) throw new SchemaError("invalid_content");
  try {
    doc.check();
  } catch (error) {
    if (error instanceof SchemaError) throw error;
    throw new SchemaError("invalid_content");
  }
}

/**
 * Relit un document JSON. Un nœud, une marque ou un attribut inconnu est rejeté
 * (SEC-DATA-02). Les attributs prévus sont contrôlés (alignement, niveau, taille).
 */
export function documentFromJson(value: unknown): PMNode {
  assertJsonNode(value, true);
  try {
    const node = schema.nodeFromJSON(value);
    node.check();
    return node;
  } catch (error) {
    if (error instanceof SchemaError) throw error;
    throw new SchemaError("invalid_content");
  }
}

function textBlock(name: string): PMNode {
  if (name === "heading") return schema.node("heading", { level: 1, align: null });
  return schema.node(name, { align: null });
}

/** Document minimal valide pour un mode. Les autres nœuds restent disponibles. */
export function emptyDocument(mode: DocumentMode): PMNode {
  if (!isDocumentMode(mode)) throw new SchemaError("invalid_attr");
  const content =
    mode === "novel"
      ? [textBlock("chapter_title"), textBlock("paragraph")]
      : mode === "screenplay"
        ? [textBlock("scene_heading"), textBlock("action")]
        : [textBlock("paragraph")];
  const doc = schema.node("doc", null, content);
  validateDocument(doc);
  return doc;
}

export function nodesForMode(mode: DocumentMode): readonly string[] {
  if (!isDocumentMode(mode)) throw new SchemaError("invalid_attr");
  return [...COMMON_NODES, ...MODE_NODES[mode]];
}

/** Nœuds présents dans le document et absents du mode. Sert à proposer une conversion. */
export function nodesOutsideMode(doc: PMNode, mode: DocumentMode): string[] {
  const allowed = new Set<string>(nodesForMode(mode));
  const found = new Set<string>();
  doc.descendants((node) => {
    if (node.isText || node.type === schema.nodes.doc) return;
    if (!allowed.has(node.type.name)) found.add(node.type.name);
  });
  return [...found].sort();
}
