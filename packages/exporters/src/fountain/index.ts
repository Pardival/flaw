import { plainText, type ExportInput, type PMJson } from "../model.ts";

/**
 * Fountain (script seulement, AC-047). Les éléments ambigus sont forcés :
 * « . » pour une scène, « @ » pour un personnage, « > » pour une transition.
 */
function line(node: PMJson): string {
  return plainText(node).replace(/\n/gu, " ").trim();
}

export function exportFountain(input: ExportInput): string {
  const out: string[] = [`Title: ${input.title.replace(/\n/gu, " ")}`];
  if (input.author) {
    out.push(`Author: ${input.author}`);
  }
  out.push("", "");
  for (const node of input.doc.content ?? []) {
    const text = line(node);
    switch (node.type) {
      case "scene_heading": {
        const upper = text.toUpperCase();
        out.push(/^(INT|EXT|EST|INT\.\/EXT|INT\/EXT|I\/E)[ .]/u.test(upper) ? upper : `.${upper}`, "");
        break;
      }
      case "character": {
        out.push(/\p{Ll}/u.test(text) ? `@${text}` : text);
        break;
      }
      case "parenthetical":
        out.push(text.startsWith("(") ? text : `(${text})`);
        break;
      case "dialogue":
        out.push(text, "");
        break;
      case "transition": {
        const upper = text.toUpperCase();
        out.push(upper.endsWith("TO:") ? upper : `> ${upper}`, "");
        break;
      }
      case "centered":
        out.push(`> ${text} <`, "");
        break;
      default:
        if (text.length > 0) {
          // Action : une ligne tout en majuscules serait lue comme personnage.
          out.push(text === text.toUpperCase() && /[A-Z]/u.test(text) ? `!${text}` : text, "");
        }
    }
  }
  return `${out.join("\n").replace(/\n{3,}/gu, "\n\n").trim()}\n`;
}
