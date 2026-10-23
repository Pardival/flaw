import type { Node as PMNode } from "prosemirror-model";

import { schema } from "../../../packages/schema/src/index.ts";
import { countWords } from "./words.ts";

const LEXICON = [
  "arbre",
  "hiver",
  "route",
  "silence",
  "fenetre",
  "lampe",
  "mer",
  "ville",
  "ombre",
  "papier",
  "encre",
  "soir",
  "matin",
  "voix",
  "pierre",
  "vent",
];

export const NOVEL_WORDS = 150_000;
const WORDS_PER_PARAGRAPH = 40;
const WORDS_PER_CHAPTER = 5_000;

function takeWords(count: number, cursor: { n: number }): string {
  const parts = new Array<string>(count);
  for (let index = 0; index < count; index += 1) {
    parts[index] = LEXICON[cursor.n % LEXICON.length] ?? "mot";
    cursor.n += 1;
  }
  return parts.join(" ");
}

function textBlock(name: string, text: string): PMNode {
  return schema.node(name, { align: null }, text.length > 0 ? [schema.text(text)] : []);
}

/** Roman du schéma unique : un titre de livre, puis des chapitres. Exactement `targetWords` mots. */
export function buildNovel(
  targetWords: number = NOVEL_WORDS,
  wordsPerChapter: number = WORDS_PER_CHAPTER,
): PMNode {
  if (!Number.isInteger(targetWords) || targetWords < 1) {
    throw new Error("nombre de mots invalide");
  }
  const blocks: PMNode[] = [];
  const cursor = { n: 0 };
  const bookTitle = "Manuscrit";
  blocks.push(textBlock("title", bookTitle));
  let remaining = targetWords - countWords(bookTitle);
  let chapter = 1;
  let chapterWords = wordsPerChapter;

  const openChapter = (): boolean => {
    const label = `Chapitre ${chapter}`;
    const cost = countWords(label);
    if (cost > remaining) return false;
    blocks.push(textBlock("chapter_title", label));
    remaining -= cost;
    chapter += 1;
    chapterWords = 0;
    return true;
  };

  if (!openChapter()) throw new Error("roman trop court pour un chapitre");

  while (remaining > 0) {
    if (chapterWords >= wordsPerChapter) openChapter();
    const size = Math.min(WORDS_PER_PARAGRAPH, remaining);
    blocks.push(textBlock("paragraph", takeWords(size, cursor)));
    remaining -= size;
    chapterWords += size;
  }

  const doc = schema.node("doc", null, blocks);
  doc.check();
  return doc;
}
