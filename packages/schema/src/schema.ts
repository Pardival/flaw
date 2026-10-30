import { Schema } from "prosemirror-model";
import type { AttributeSpec, DOMOutputSpec, Mark, Node as PMNode, NodeSpec } from "prosemirror-model";

import { assertAlign, assertAlt, assertAssetId, assertCrop, assertFontSize, assertImageAlign, assertImageRatio, assertImageWidth, assertLevel } from "./attrs.ts";
import type { Align } from "./constants.ts";

/**
 * Schéma ProseMirror unique (A-018).
 * Tous les modes partagent ce schéma : un changement de mode ne retire aucun nœud.
 * Pas de parseDOM : un DOMParser recolle le texte des éléments `script`.
 * Le collage HTML passe par `parsePastedHtml` (SEC-WEB-06).
 * Aucun lien ni HTML stocké (SEC-DATA-02). Une image ne désigne qu'un fichier du
 * texte lui-même (empreinte), jamais une URL.
 */

const alignAttr: AttributeSpec = {
  default: null,
  validate: assertAlign,
};

const levelAttr: AttributeSpec = {
  default: 1,
  validate: assertLevel,
};

function alignOf(node: PMNode): Align | null {
  const value = node.attrs.align;
  if (value === "left" || value === "center" || value === "right" || value === "justify") {
    return value;
  }
  return null;
}

function renderTextBlock(tag: string, flawNode: string, node: PMNode): DOMOutputSpec {
  const attrs: Record<string, string> = { "data-flaw-node": flawNode };
  const align = alignOf(node);
  if (align !== null) attrs["data-align"] = align;
  return [tag, attrs, 0];
}

function textBlock(name: string, defining: boolean): NodeSpec {
  const spec: NodeSpec = {
    content: "inline*",
    group: "block",
    attrs: { align: alignAttr },
    toDOM(node) {
      return renderTextBlock("p", name, node);
    },
  };
  if (defining) spec.defining = true;
  return spec;
}

const nodes: { [name: string]: NodeSpec } = {
  doc: { content: "block+" },
  paragraph: textBlock("paragraph", false),
  title: textBlock("title", true),
  chapter_title: textBlock("chapter_title", true),
  heading: {
    content: "inline*",
    group: "block",
    defining: true,
    attrs: { level: levelAttr, align: alignAttr },
    toDOM(node) {
      const level = node.attrs.level === 2 || node.attrs.level === 3 ? node.attrs.level : 1;
      const attrs: Record<string, string> = {
        "data-flaw-node": "heading",
        "data-level": String(level),
      };
      const align = alignOf(node);
      if (align !== null) attrs["data-align"] = align;
      return [`h${level}`, attrs, 0];
    },
  },
  scene_break: {
    group: "block",
    atom: true,
    toDOM() {
      return ["hr", { "data-flaw-node": "scene_break" }];
    },
  },
  image: {
    group: "block",
    atom: true,
    draggable: true,
    selectable: true,
    attrs: {
      asset: { validate: (value: unknown) => assertAssetId(value, false) },
      original: { default: null, validate: (value: unknown) => assertAssetId(value, true) },
      width: { default: 60, validate: assertImageWidth },
      ratio: { default: 0.75, validate: assertImageRatio },
      align: { default: "center", validate: assertImageAlign },
      crop: { default: null, validate: assertCrop },
      alt: { default: "", validate: assertAlt },
    },
    toDOM(node) {
      // L'éditeur affiche le fichier par une vue dédiée ; ici, seulement la place réservée.
      return [
        "figure",
        {
          "data-flaw-node": "image",
          "data-align": String(node.attrs.align),
          "data-width": String(node.attrs.width),
        },
      ];
    },
  },
  scene_heading: textBlock("scene_heading", true),
  action: textBlock("action", false),
  character: textBlock("character", true),
  parenthetical: textBlock("parenthetical", true),
  dialogue: textBlock("dialogue", false),
  transition: textBlock("transition", true),
  centered: textBlock("centered", false),
  text: {
    group: "inline",
  }, // ProseMirror exige un type text.
  hard_break: {
    inline: true,
    group: "inline",
    selectable: false,
    toDOM() {
      return ["br"];
    },
  },
  bullet_list: {
    content: "list_item+",
    group: "block",
    toDOM() {
      return ["ul", 0];
    },
  },
  ordered_list: {
    content: "list_item+",
    group: "block",
    toDOM() {
      return ["ol", 0];
    },
  },
  list_item: {
    content: "paragraph+ nested_list?",
    defining: true,
    toDOM() {
      return ["li", 0];
    },
  },
  bullet_list_2: {
    content: "list_item_2+",
    group: "nested_list",
    toDOM() {
      return ["ul", { "data-flaw-depth": "2" }, 0];
    },
  },
  ordered_list_2: {
    content: "list_item_2+",
    group: "nested_list",
    toDOM() {
      return ["ol", { "data-flaw-depth": "2" }, 0];
    },
  },
  list_item_2: {
    content: "paragraph+",
    defining: true,
    toDOM() {
      return ["li", 0];
    },
  },
};

const marks = {
  bold: {
    toDOM(): DOMOutputSpec {
      return ["strong", 0];
    },
  },
  italic: {
    toDOM(): DOMOutputSpec {
      return ["em", 0];
    },
  },
  font_size: {
    attrs: { pt: { validate: assertFontSize } },
    toDOM(mark: Mark): DOMOutputSpec {
      return ["span", { "data-font-size": String(mark.attrs.pt) }, 0];
    },
  },
};

export const schema = new Schema({ nodes, marks });
