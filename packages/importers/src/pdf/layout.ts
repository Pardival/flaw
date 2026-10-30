import type { Block } from "../blocks.ts";

/**
 * Reconstitution du texte d'un PDF (A-017). Un PDF ne garde que des morceaux de
 * texte positionnés : on regroupe en lignes, on retire folios et en-têtes courants,
 * puis on recoud les paragraphes (écart vertical, alinéa, ligne courte) et les
 * mots coupés en fin de ligne. La mise en page d'origine n'est pas conservée.
 */
export type PdfItem = { text: string; x: number; y: number; width: number; height: number };
export type PdfPage = { width: number; height: number; items: PdfItem[] };

type Line = { text: string; left: number; right: number; y: number; size: number };

const TERMINAL = /[.!?…»"”:;)]$/u;
const DIALOGUE = /^[—–-]\s/u;
const SCENE_BREAK = /^(\*\s*){1,3}$|^#$|^(•\s*){3}$/u;
const FOLIO = /^(page\s+)?[-–—]?\s*\d{1,4}\s*[-–—]?$|^[ivxlcdm]{1,6}$/iu;
/** Part de la hauteur de page où vivent folios et en-têtes courants. */
const MARGIN_BAND = 0.09;

function percentile(values: number[], rank: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * rank)] ?? 0;
}

function median(values: number[]): number {
  return percentile(values, 0.5);
}

function toLines(page: PdfPage): Line[] {
  const lines: Line[] = [];
  let current: Line | null = null;
  for (const item of page.items) {
    const text = item.text.replace(/\s+/gu, " ");
    if (text.trim().length === 0 && current === null) {
      continue;
    }
    const size = Math.max(item.height, 1);
    if (current !== null && Math.abs(item.y - current.y) < Math.max(size, current.size) * 0.5) {
      const gap = item.x - current.right;
      const needsSpace = gap > size * 0.15 && !current.text.endsWith(" ") && !text.startsWith(" ");
      current.text += (needsSpace ? " " : "") + text;
      current.right = Math.max(current.right, item.x + item.width);
      current.left = Math.min(current.left, item.x);
      current.size = Math.max(current.size, size);
      continue;
    }
    if (current !== null) {
      lines.push(current);
    }
    current = { text, left: item.x, right: item.x + item.width, y: item.y, size };
  }
  if (current !== null) {
    lines.push(current);
  }
  return lines
    .map((line) => ({ ...line, text: line.text.trim() }))
    .filter((line) => line.text.length > 0);
}

function inMargin(line: Line, page: PdfPage): boolean {
  const band = page.height * MARGIN_BAND;
  return line.y < band || line.y > page.height - band;
}

/** Texte d'en-tête ou de pied comparable d'une page à l'autre (chiffres ignorés). */
function runningKey(text: string): string {
  return text.replace(/\d+/gu, "#").toLowerCase();
}

function stripFurniture(pages: PdfPage[], linesByPage: Line[][]): Line[][] {
  const counts = new Map<string, number>();
  linesByPage.forEach((lines, index) => {
    const page = pages[index] as PdfPage;
    const seen = new Set<string>();
    for (const line of lines) {
      if (inMargin(line, page)) {
        seen.add(runningKey(line.text));
      }
    }
    for (const key of seen) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  });
  const repeated = Math.max(3, Math.ceil(pages.length * 0.3));
  return linesByPage.map((lines, index) => {
    const page = pages[index] as PdfPage;
    return lines.filter((line) => {
      if (!inMargin(line, page)) {
        return true;
      }
      if (FOLIO.test(line.text)) {
        return false;
      }
      return pages.length < 3 || (counts.get(runningKey(line.text)) ?? 0) < repeated;
    });
  });
}

function join(previous: string, next: string): string {
  // Mot coupé en fin de ligne : « connais-/sait » → « connaissait ».
  if (/\p{L}-$/u.test(previous) && /^\p{Ll}/u.test(next)) {
    return previous.slice(0, -1) + next;
  }
  return `${previous} ${next}`;
}

export function pagesToBlocks(pages: PdfPage[]): Block[] {
  const linesByPage = stripFurniture(pages, pages.map(toLines));
  const all = linesByPage.flat();
  const body = median(all.map((line) => line.size));
  // Marge gauche : les lignes à alinéa sont souvent majoritaires, d'où un bas centile plutôt que la médiane.
  const left = percentile(all.filter((line) => Math.abs(line.size - body) < body * 0.2).map((line) => line.left), 0.1);
  const right = Math.max(...all.map((line) => line.right), 0);

  const blocks: Block[] = [];
  let paragraph: string | null = null;
  let lastLine: Line | null = null;
  const flush = () => {
    if (paragraph !== null && paragraph.trim().length > 0) {
      blocks.push({ kind: "paragraph", runs: [{ text: paragraph.trim() }] });
    }
    paragraph = null;
  };

  linesByPage.forEach((lines) => {
    const gaps: number[] = [];
    for (let index = 1; index < lines.length; index += 1) {
      const gap = Math.abs((lines[index] as Line).y - (lines[index - 1] as Line).y);
      if (gap > 0) {
        gaps.push(gap);
      }
    }
    const spacing = median(gaps) || body * 1.2;
    lines.forEach((line, index) => {
      if (SCENE_BREAK.test(line.text)) {
        flush();
        blocks.push({ kind: "break" });
        lastLine = null;
        return;
      }
      if (line.size >= body * 1.25 && line.text.length <= 120) {
        flush();
        const level = line.size >= body * 1.6 ? 1 : 2;
        const previous = blocks[blocks.length - 1];
        // Titre sur deux lignes : on le garde d'un seul tenant.
        if (lastLine !== null && lastLine.size >= body * 1.25 && previous?.kind === "heading") {
          previous.runs = [{ text: join(previous.runs[0]?.text ?? "", line.text) }];
        } else {
          blocks.push({ kind: "heading", level, runs: [{ text: line.text }] });
        }
        lastLine = line;
        return;
      }
      const indented = line.left > left + body * 0.8;
      const previous: Line | null = lastLine;
      let starts = paragraph === null || DIALOGUE.test(line.text);
      if (!starts && previous !== null) {
        const samePage = index > 0;
        const gap = samePage ? Math.abs(line.y - previous.y) : 0;
        const shortPrevious = previous.right < right - body * 3 && TERMINAL.test(previous.text);
        const pageTurnEnds = !samePage && TERMINAL.test(previous.text) && (indented || shortPrevious);
        starts = (samePage && gap > spacing * 1.45) || (samePage && indented) || (samePage && shortPrevious) || pageTurnEnds || previous.size >= body * 1.25;
      }
      if (starts) {
        flush();
        paragraph = line.text;
      } else {
        paragraph = join(paragraph ?? "", line.text);
      }
      lastLine = line;
    });
  });
  flush();
  return blocks;
}
