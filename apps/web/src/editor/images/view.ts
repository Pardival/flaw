import { IMAGE_WIDTH_MAX, IMAGE_WIDTH_MIN, schema } from "@flaw/schema/src/index.ts";
import type { Node as PMNode } from "prosemirror-model";
import { NodeSelection, type EditorState, type Transaction } from "prosemirror-state";
import type { EditorView, NodeView } from "prosemirror-view";
import type * as Y from "yjs";

import { assetUrl } from "./assets.ts";

export type ImageViewOptions = {
  doc: Y.Doc;
  /** Largeur maximale (%) pour que l'image tienne dans la hauteur d'une page. */
  maxWidth: (ratio: number) => number;
  onCrop: (pos: number) => void;
  labels: { left: string; center: string; right: string; crop: string; remove: string; resize: string; missing: string };
};

type Align = "left" | "center" | "right";

function clampWidth(value: number): number {
  return Math.round(Math.min(IMAGE_WIDTH_MAX, Math.max(IMAGE_WIDTH_MIN, value)));
}

/**
 * Image dans le livre : cadre au rapport fixé (la pagination le mesure sans
 * attendre le chargement), poignées latérales pour la largeur, petite barre
 * d'outils quand elle est sélectionnée.
 */
class ImageView implements NodeView {
  dom: HTMLElement;
  private frame: HTMLElement;
  private img: HTMLImageElement;
  private node: PMNode;

  constructor(
    node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
    private options: ImageViewOptions,
  ) {
    this.node = node;
    this.dom = document.createElement("figure");
    this.dom.dataset.flawNode = "image";
    this.dom.className = "flaw-image";
    this.dom.contentEditable = "false";
    this.frame = document.createElement("div");
    this.frame.className = "flaw-image-frame";
    this.img = document.createElement("img");
    this.img.draggable = false;
    this.img.decoding = "async";
    this.frame.append(this.img);
    for (const side of ["left", "right"] as const) {
      const handle = document.createElement("span");
      handle.className = `flaw-image-handle flaw-image-handle-${side}`;
      handle.setAttribute("aria-label", options.labels.resize);
      handle.addEventListener("pointerdown", (event) => this.startResize(event, side));
      this.frame.append(handle);
    }
    this.frame.append(this.toolbar());
    this.dom.append(this.frame);
    this.render();
  }

  private toolbar(): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "flaw-image-toolbar";
    bar.setAttribute("role", "toolbar");
    const button = (label: string, title: string, action: () => void, key?: Align) => {
      const element = document.createElement("button");
      element.type = "button";
      element.textContent = label;
      element.title = title;
      element.setAttribute("aria-label", title);
      if (key !== undefined) element.dataset.align = key;
      element.addEventListener("pointerdown", (event) => event.preventDefault());
      element.addEventListener("click", (event) => {
        event.preventDefault();
        action();
      });
      bar.append(element);
    };
    const { labels } = this.options;
    button("⇤", labels.left, () => this.setAttrs({ align: "left" }), "left");
    button("↔", labels.center, () => this.setAttrs({ align: "center" }), "center");
    button("⇥", labels.right, () => this.setAttrs({ align: "right" }), "right");
    const sep = document.createElement("span");
    sep.className = "flaw-image-sep";
    bar.append(sep);
    button("✂", labels.crop, () => {
      const pos = this.getPos();
      if (pos !== undefined) this.options.onCrop(pos);
    });
    button("🗑", labels.remove, () => {
      const pos = this.getPos();
      if (pos === undefined) return;
      this.view.dispatch(this.view.state.tr.delete(pos, pos + this.node.nodeSize));
      this.view.focus();
    });
    return bar;
  }

  private render(): void {
    const { asset, width, ratio, align, alt } = this.node.attrs as { asset: string; width: number; ratio: number; align: Align; alt: string };
    const shown = Math.min(width, this.options.maxWidth(ratio));
    this.dom.dataset.align = align;
    this.frame.style.width = `${String(shown)}%`;
    this.frame.style.aspectRatio = `1 / ${String(ratio)}`;
    const url = assetUrl(this.options.doc, asset);
    if (url !== null) {
      if (this.img.src !== url) this.img.src = url;
      this.img.alt = alt;
      this.dom.classList.remove("is-missing");
    } else {
      this.img.removeAttribute("src");
      this.img.alt = this.options.labels.missing;
      this.dom.classList.add("is-missing");
    }
    for (const element of this.dom.querySelectorAll<HTMLElement>(".flaw-image-toolbar [data-align]")) {
      element.setAttribute("aria-pressed", String(element.dataset.align === align));
    }
  }

  private setAttrs(patch: Record<string, unknown>): void {
    const pos = this.getPos();
    if (pos === undefined) return;
    const tr = this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, ...patch });
    tr.setSelection(NodeSelection.create(tr.doc, pos));
    this.view.dispatch(tr);
  }

  private startResize(event: PointerEvent, side: "left" | "right"): void {
    event.preventDefault();
    event.stopPropagation();
    const container = this.dom.getBoundingClientRect().width;
    const start = this.frame.getBoundingClientRect().width;
    const startX = event.clientX;
    const centered = this.node.attrs.align === "center";
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    this.dom.classList.add("is-resizing");
    let next = this.node.attrs.width as number;
    const move = (moveEvent: PointerEvent) => {
      const delta = (moveEvent.clientX - startX) * (side === "left" ? -1 : 1) * (centered ? 2 : 1);
      next = clampWidth(Math.min(((start + delta) / container) * 100, this.options.maxWidth(this.node.attrs.ratio as number)));
      this.frame.style.width = `${String(next)}%`;
    };
    const end = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", end);
      target.removeEventListener("pointercancel", end);
      this.dom.classList.remove("is-resizing");
      if (next !== this.node.attrs.width) this.setAttrs({ width: next });
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end);
    target.addEventListener("pointercancel", end);
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }

  selectNode(): void {
    this.dom.classList.add("is-selected");
  }

  deselectNode(): void {
    this.dom.classList.remove("is-selected");
  }

  stopEvent(event: Event): boolean {
    const target = event.target as HTMLElement | null;
    return target !== null && target.closest(".flaw-image-toolbar, .flaw-image-handle") !== null;
  }

  ignoreMutation(): boolean {
    return true;
  }
}

export function imageNodeView(options: ImageViewOptions) {
  return (node: PMNode, view: EditorView, getPos: () => number | undefined): NodeView => new ImageView(node, view, getPos, options);
}

/** Insère une image après le bloc courant (jamais au milieu d'une phrase). */
export function insertImage(state: EditorState, attrs: Record<string, unknown>, at?: number): Transaction | null {
  const type = schema.nodes.image;
  if (type === undefined) return null;
  const node = type.create(attrs);
  const $pos = state.doc.resolve(at ?? state.selection.to);
  let insertAt: number;
  if (state.selection instanceof NodeSelection && at === undefined) {
    insertAt = state.selection.to;
  } else if ($pos.depth === 0) {
    insertAt = $pos.pos;
  } else {
    const empty = $pos.parent.isTextblock && $pos.parent.content.size === 0 && $pos.depth === 1;
    // Paragraphe vide : l'image prend sa place.
    if (empty) {
      const tr = state.tr.replaceWith($pos.before(1), $pos.after(1), node);
      return tr.setSelection(NodeSelection.create(tr.doc, $pos.before(1))).scrollIntoView();
    }
    insertAt = $pos.after(1);
  }
  const tr = state.tr.insert(insertAt, node);
  return tr.setSelection(NodeSelection.create(tr.doc, insertAt)).scrollIntoView();
}
