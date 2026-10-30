import { describe, expect, it } from "vitest";

import { importFile, importFileAsync, toDocument } from "../src/index.ts";
import { pagesToBlocks, type PdfItem } from "../src/pdf/layout.ts";

type Text = { x: number; y: number; size: number; text: string };

/** Encodage WinAnsi d'une chaîne littérale PDF (accents en octal). */
function literal(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char === "’" ? 0x92 : char === "—" ? 0x97 : char === "«" ? 0xab : char === "»" ? 0xbb : (char.codePointAt(0) ?? 63);
    if (char === "(" || char === ")" || char === "\\") out += `\\${char}`;
    else if (code < 128) out += char;
    else out += `\\${code.toString(8).padStart(3, "0")}`;
  }
  return `(${out})`;
}

/** Petit PDF valide (Helvetica, A5) : une liste de lignes par page. */
function makePdf(pages: Text[][], title?: string): Uint8Array {
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const pagesId = objects.length + 1;
  objects.push("");
  const kids: number[] = [];
  for (const lines of pages) {
    const stream = lines.map((line) => `BT /F1 ${line.size} Tf ${line.x} ${line.y} Td ${literal(line.text)} Tj ET`).join("\n");
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 420 595] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  const info = title ? add(`<< /Title ${literal(title)} >>`) : null;
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R${info ? ` /Info ${info} 0 R` : ""} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(pdf, (char) => char.charCodeAt(0) & 0xff);
}

/** Page de roman : titre, deux paragraphes avec alinéa, mot coupé, folio. */
function novelPage(folio: number, first: boolean): Text[] {
  const lines: Text[] = [];
  let y = 540;
  if (first) {
    lines.push({ x: 120, y, size: 20, text: "Chapitre premier" });
    y -= 40;
  }
  lines.push({ x: 62, y, size: 11, text: "Élias Morel avait toujours cru qu’il se connais-" });
  lines.push({ x: 50, y: y - 14, size: 11, text: "sait. C’était, pensait-il, la seule chose sûre." });
  lines.push({ x: 62, y: y - 28, size: 11, text: "— Tu te trompes, dit Paul, et tu le sais bien." });
  lines.push({ x: 62, y: y - 42, size: 11, text: "Il garda le silence longtemps, en regardant la mer" });
  lines.push({ x: 50, y: y - 56, size: 11, text: "qui montait sous les fenêtres de la vieille maison" });
  lines.push({ x: 200, y: 30, size: 9, text: String(folio) });
  lines.push({ x: 150, y: 570, size: 9, text: "Le Cartographe des oublis" });
  return lines;
}

describe("import PDF", () => {
  it("reconstitue titres, paragraphes, dialogues et mots coupés ; retire folios et en-têtes", async () => {
    const pdf = makePdf([novelPage(1, true), novelPage(2, false), novelPage(3, false)], "Le Cartographe");
    const result = await importFileAsync(pdf, "roman.pdf");
    expect(result.title).toBe("Le Cartographe");
    expect(result.suggestedMode).toBe("novel");
    const texts = result.blocks.map((block) => (block.kind === "break" ? "***" : `${block.kind}:${block.runs.map((run) => run.text).join("")}`));
    expect(texts[0]).toBe("heading:Chapitre premier");
    expect(texts[1]).toBe("paragraph:Élias Morel avait toujours cru qu’il se connaissait. C’était, pensait-il, la seule chose sûre.");
    expect(texts[2]).toBe("paragraph:— Tu te trompes, dit Paul, et tu le sais bien.");
    // Paragraphe sans point final : il continue sur la page suivante.
    expect(texts[3]).toBe("paragraph:Il garda le silence longtemps, en regardant la mer qui montait sous les fenêtres de la vieille maison Élias Morel avait toujours cru qu’il se connaissait. C’était, pensait-il, la seule chose sûre.");
    expect(texts.join("\n")).not.toMatch(/^paragraph:\d+$/mu);
    expect(texts.join("\n")).not.toContain("paragraph:Le Cartographe des oublis");
    expect(toDocument(result.blocks, "novel").type).toBe("doc");
  });

  it("titre de repli : le nom du fichier", async () => {
    const result = await importFileAsync(makePdf([[{ x: 50, y: 500, size: 11, text: "Une seule ligne." }]]), "Mon essai.pdf");
    expect(result.title).toBe("Mon essai");
    expect(result.blocks).toEqual([{ kind: "paragraph", runs: [{ text: "Une seule ligne." }] }]);
  });

  it("refuse un PDF sans texte (scanné) et un PDF abîmé", async () => {
    await expect(importFileAsync(makePdf([[]]), "scan.pdf")).rejects.toMatchObject({ code: "pdf_no_text" });
    await expect(importFileAsync(new TextEncoder().encode("%PDF-1.7\nrien du tout"), "abime.pdf")).rejects.toMatchObject({ code: "pdf_invalid" });
  });

  it("l'import synchrone ne lit jamais un PDF (le contenu prime sur l'extension)", () => {
    expect(() => importFile(makePdf([[{ x: 50, y: 500, size: 11, text: "x" }]]), "note.md")).toThrow("unsupported");
  });
});

describe("reconstitution des lignes", () => {
  const item = (text: string, x: number, y: number, size = 10): PdfItem => ({ text, x, y, width: text.length * size * 0.5, height: size });

  it("recolle les morceaux d'une même ligne et repère la séparation de scène", () => {
    const blocks = pagesToBlocks([
      { width: 400, height: 600, items: [item("Bonjour", 50, 500), item("tout le monde.", 90, 500), item("* * *", 180, 470), item("Plus tard.", 50, 440)] },
    ]);
    expect(blocks).toEqual([
      { kind: "paragraph", runs: [{ text: "Bonjour tout le monde." }] },
      { kind: "break" },
      { kind: "paragraph", runs: [{ text: "Plus tard." }] },
    ]);
  });
});
