import MarkdownIt from "markdown-it";

import { suggestMode, type Block, type ImportResult, type Run } from "../blocks.ts";
import { fail } from "../errors.ts";
import { LIMITS } from "../limits.ts";
import { decodeText } from "../text/index.ts";

/**
 * Markdown (T-039, H9) : markdown-it en CommonMark, parse() seul (aucun rendu HTML),
 * html, linkify et typographer désactivés. Liens → texte, images → texte alternatif
 * jamais chargé, HTML brut gardé en texte littéral. Imbrication > 20 : refus (jamais tronqué).
 */
type Token = ReturnType<InstanceType<typeof MarkdownIt>["parse"]>[number];

const parser = new MarkdownIt("commonmark", { html: false, linkify: false, typographer: false });
parser.set({ maxNesting: 100 });

function runsOf(token: Token | undefined, report: { simplified: boolean }): Run[] {
  const runs: Run[] = [];
  let bold = 0;
  let italic = 0;
  for (const child of token?.children ?? []) {
    switch (child.type) {
      case "text":
      case "code_inline":
      case "html_inline":
        runs.push({ text: child.content, bold: bold > 0, italic: italic > 0 });
        break;
      case "strong_open":
        bold += 1;
        break;
      case "strong_close":
        bold -= 1;
        break;
      case "em_open":
        italic += 1;
        break;
      case "em_close":
        italic -= 1;
        break;
      case "softbreak":
        runs.push({ text: " " });
        break;
      case "hardbreak":
        runs.push({ text: "", br: true });
        break;
      case "image":
        report.simplified = true;
        runs.push({ text: child.content, bold: bold > 0, italic: italic > 0 });
        break;
      case "link_open":
      case "link_close":
        report.simplified = true;
        break;
      default:
        break;
    }
  }
  return runs;
}

export function importMarkdown(bytes: Uint8Array, fileName: string): ImportResult {
  const { text, windows1252 } = decodeText(bytes);
  const tokens = parser.parse(text, {});
  const report = { simplified: false, invisible: 0, externalLinks: 0, footnotes: 0, windows1252 };
  const blocks: Block[] = [];
  const lists: boolean[] = [];
  let depth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as Token;
    depth = Math.max(depth, token.level);
    if (token.level > LIMITS.markdownNesting * 2) fail("nesting");
    if (token.type === "bullet_list_open" || token.type === "ordered_list_open" || token.type === "blockquote_open") {
      if (token.type !== "blockquote_open") lists.push(token.type === "ordered_list_open");
      if (lists.length > LIMITS.markdownNesting) fail("nesting");
    } else if (token.type === "bullet_list_close" || token.type === "ordered_list_close") {
      lists.pop();
    } else if (token.type === "heading_open") {
      const level = Math.min(3, Number(token.tag.slice(1))) as 1 | 2 | 3;
      blocks.push({ kind: "heading", level, runs: runsOf(tokens[index + 1], report) });
      index += 2;
    } else if (token.type === "paragraph_open") {
      const runs = runsOf(tokens[index + 1], report);
      if (lists.length > 0) {
        blocks.push({ kind: "item", ordered: lists[lists.length - 1] ?? false, level: lists.length > 1 ? 2 : 1, runs });
      } else {
        blocks.push({ kind: "paragraph", runs });
      }
      index += 2;
    } else if (token.type === "fence" || token.type === "code_block" || token.type === "html_block") {
      for (const line of token.content.replace(/\n$/u, "").split("\n")) {
        blocks.push({ kind: "paragraph", runs: [{ text: line }] });
      }
    } else if (token.type === "hr") {
      blocks.push({ kind: "break" });
    }
  }
  return {
    title: fileName.replace(/\.(md|markdown)$/iu, "").trim() || "Sans titre",
    suggestedMode: suggestMode(blocks, false),
    blocks,
    report,
  };
}
