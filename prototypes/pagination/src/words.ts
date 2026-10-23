import type { Node as PMNode } from "prosemirror-model";

export function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

/** Compte les mots de chaque bloc de premier niveau. Une fois, au chargement. */
export function countBlocks(doc: PMNode): number[] {
  const counts = new Array<number>(doc.childCount);
  doc.forEach((node, _offset, index) => {
    counts[index] = countWords(node.textContent);
  });
  return counts;
}

export function totalWords(counts: readonly number[]): number {
  let total = 0;
  for (const count of counts) total += count;
  return total;
}

/**
 * Recompte seulement les blocs dont l'identité a changé.
 * Le préfixe et le suffixe inchangés sont recopiés.
 */
export function updateCounts(before: PMNode, after: PMNode, counts: readonly number[]): number[] {
  const next = new Array<number>(after.childCount);
  const beforeCount = before.childCount;
  const afterCount = after.childCount;
  let start = 0;
  const shared = Math.min(beforeCount, afterCount);
  while (start < shared && before.child(start) === after.child(start)) start += 1;

  let beforeEnd = beforeCount - 1;
  let afterEnd = afterCount - 1;
  while (
    beforeEnd >= start &&
    afterEnd >= start &&
    before.child(beforeEnd) === after.child(afterEnd)
  ) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }

  for (let index = 0; index < start; index += 1) {
    const value = counts[index];
    if (value === undefined) throw new Error("compteur incomplet");
    next[index] = value;
  }
  for (let index = start; index <= afterEnd; index += 1) {
    next[index] = countWords(after.child(index).textContent);
  }
  const tail = afterCount - afterEnd - 1;
  for (let offset = 1; offset <= tail; offset += 1) {
    const value = counts[beforeEnd + offset];
    if (value === undefined) throw new Error("compteur incomplet");
    next[afterEnd + offset] = value;
  }
  return next;
}
