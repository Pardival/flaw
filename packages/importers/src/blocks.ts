import { fail } from "./errors.ts";
import { LIMITS } from "./limits.ts";
import { clean } from "./text.ts";

/** Résultat neutre d'un import, converti ensuite selon le mode choisi (AC-082). */
export type Run = { text: string; bold?: boolean; italic?: boolean; br?: boolean };
export type Block =
  | { kind: "heading"; level: 1 | 2 | 3; runs: Run[] }
  | { kind: "paragraph"; runs: Run[]; align?: "left" | "center" | "right" | "justify" }
  | { kind: "item"; ordered: boolean; level: 1 | 2; runs: Run[] }
  | { kind: "break" };

export type ImportMode = "novel" | "screenplay" | "document" | "blank";

export type ImportReport = { simplified: boolean; invisible: number; externalLinks: number; footnotes: number; windows1252?: boolean };

export type ImportResult = { title: string; suggestedMode: ImportMode; blocks: Block[]; report: ImportReport };

type Json = { type: string; attrs?: Record<string, unknown>; content?: Json[]; text?: string; marks?: Array<{ type: string }> };

function inline(runs: Run[]): Json[] {
  const out: Json[] = [];
  for (const run of runs) {
    if (run.br) {
      out.push({ type: "hard_break" });
      continue;
    }
    const text = clean(run.text);
    if (text.length === 0) {
      continue;
    }
    const marks = [...(run.bold ? [{ type: "bold" }] : []), ...(run.italic ? [{ type: "italic" }] : [])];
    out.push(marks.length > 0 ? { type: "text", text, marks } : { type: "text", text });
  }
  return out;
}

function textBlock(type: string, runs: Run[], attrs: Record<string, unknown> = { align: null }): Json {
  const content = inline(runs);
  return content.length > 0 ? { type, attrs, content } : { type, attrs };
}

/** Blocs → JSON ProseMirror de @flaw/schema pour le mode choisi. */
export function toDocument(blocks: Block[], mode: ImportMode): Json {
  const out: Json[] = [];
  let list: { node: Json; ordered: boolean } | null = null;
  let lastItem: Json | null = null;
  const closeList = () => {
    list = null;
    lastItem = null;
  };
  for (const block of blocks) {
    if (block.kind === "item" && mode === "document") {
      const kind = block.ordered ? "ordered_list" : "bullet_list";
      const paragraph = textBlock("paragraph", block.runs);
      if (block.level === 2 && lastItem !== null) {
        const item = lastItem as Json;
        const children = item.content ?? [];
        const nested = children.find((child) => child.type.endsWith("_2"));
        const nestedKind = block.ordered ? "ordered_list_2" : "bullet_list_2";
        if (nested && nested.type === nestedKind) {
          nested.content = [...(nested.content ?? []), { type: "list_item_2", content: [paragraph] }];
        } else if (!nested) {
          item.content = [...children, { type: nestedKind, content: [{ type: "list_item_2", content: [paragraph] }] }];
        } else {
          nested.content = [...(nested.content ?? []), { type: "list_item_2", content: [paragraph] }];
        }
        continue;
      }
      const current = list as { node: Json; ordered: boolean } | null;
      if (current === null || current.ordered !== block.ordered) {
        const node: Json = { type: kind, content: [] };
        out.push(node);
        list = { node, ordered: block.ordered };
      }
      const item: Json = { type: "list_item", content: [paragraph] };
      (list as unknown as { node: Json }).node.content?.push(item);
      lastItem = item;
      continue;
    }
    closeList();
    if (block.kind === "break") {
      out.push(mode === "novel" ? { type: "scene_break" } : textBlock("paragraph", [{ text: "*  *  *" }], { align: "center" }));
    } else if (block.kind === "heading") {
      if (mode === "document") {
        out.push(textBlock("heading", block.runs, { level: block.level, align: null }));
      } else if (mode === "novel" && block.level === 1) {
        out.push(textBlock("chapter_title", block.runs));
      } else if (mode === "screenplay") {
        out.push(textBlock("scene_heading", block.runs));
      } else {
        out.push(textBlock("paragraph", block.runs));
      }
    } else if (block.kind === "item") {
      out.push(textBlock(mode === "screenplay" ? "action" : "paragraph", [{ text: block.ordered ? "– " : "• " }, ...block.runs]));
    } else {
      out.push(textBlock(mode === "screenplay" ? "action" : "paragraph", block.runs, { align: block.align ?? null }));
    }
  }
  if (out.length === 0) {
    out.push(mode === "screenplay" ? { type: "action", attrs: { align: null } } : { type: "paragraph", attrs: { align: null } });
  }
  const doc: Json = { type: "doc", content: out };
  if (JSON.stringify(doc).length > LIMITS.outputBytes) {
    fail("output_too_large");
  }
  return doc;
}

/** Mode proposé (AC-082) : .docx avec des titres « Chapitre » → roman, sinon document. */
export function suggestMode(blocks: Block[], fromDocx: boolean): ImportMode {
  if (!fromDocx) {
    return "document";
  }
  const chapters = blocks.filter(
    (block) => block.kind === "heading" && /^\s*(chapitre|chapter|chap\.)\b/iu.test(block.runs.map((run) => run.text).join("")),
  );
  return chapters.length > 0 ? "novel" : "document";
}
