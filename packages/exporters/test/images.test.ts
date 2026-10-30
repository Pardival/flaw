import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { exportDocx, exportEpub, pdfData, pdfFiles, type ExportInput } from "../src/index.ts";

const ID = "0123456789abcdef0123456789abcdef";
// En-tête PNG suffisant : les exporteurs recopient les octets sans les décoder.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 4, 5, 6]);

function input(extra: Partial<ExportInput> = {}): ExportInput {
  return {
    title: "Le Cartographe",
    mode: "novel",
    pageFormat: "novel_13x20",
    lang: "fr",
    doc: {
      type: "doc",
      content: [
        { type: "chapter_title", attrs: { align: null }, content: [{ type: "text", text: "Les carnets" }] },
        { type: "paragraph", attrs: { align: null }, content: [{ type: "text", text: "Il ouvrit la carte." }] },
        { type: "image", attrs: { asset: ID, original: null, width: 80, ratio: 0.5, align: "right", crop: null, alt: "Carte <du> littoral" } },
      ],
    },
    assets: { [ID]: { bytes: PNG, kind: "png" } },
    ...extra,
  };
}

describe("images et couvertures dans les exports", () => {
  it("EPUB : image jointe et déclarée, texte alternatif échappé, couverture en tête", () => {
    const files = unzipSync(exportEpub(input({ cover: { front: { bytes: JPEG, kind: "jpeg" } } }), "id-1", new Date("2026-10-30T00:00:00Z")));
    expect(files[`OEBPS/images/${ID}.png`]).toEqual(PNG);
    expect(files["OEBPS/images/cover.jpg"]).toEqual(JPEG);
    const opf = strFromU8(files["OEBPS/content.opf"] as Uint8Array);
    expect(opf).toContain(`href="images/${ID}.png" media-type="image/png"`);
    expect(opf).toContain('properties="cover-image"');
    expect(opf.indexOf('idref="cover"')).toBeLessThan(opf.indexOf('idref="title"'));
    const chapter = strFromU8(files["OEBPS/chapter-001.xhtml"] as Uint8Array);
    expect(chapter).toContain(`<img src="images/${ID}.png" alt="Carte &lt;du&gt; littoral" style="width:80%"/>`);
  });

  it("EPUB : une image sans fichier joint est ignorée", () => {
    const files = unzipSync(exportEpub(input({ assets: {} }), "id-2"));
    expect(strFromU8(files["OEBPS/chapter-001.xhtml"] as Uint8Array)).not.toContain("<img");
  });

  it("Word : l'image et les couvertures entrent dans le document", async () => {
    const files = unzipSync(await exportDocx(input({ cover: { front: { bytes: JPEG, kind: "jpeg" }, back: { bytes: JPEG, kind: "jpeg" } } })));
    const media = Object.keys(files).filter((name) => name.startsWith("word/media/"));
    expect(media.length).toBeGreaterThanOrEqual(2);
    expect(strFromU8(files["word/document.xml"] as Uint8Array).match(/<w:drawing>/gu)?.length).toBe(3);
  });

  it("PDF : fichiers montés à des chemins d'empreinte, couvertures déclarées", () => {
    const files = pdfFiles(input({ cover: { back: { bytes: JPEG, kind: "jpeg" } }, assets: { [ID]: { bytes: PNG, kind: "png" }, "../evil": { bytes: PNG, kind: "png" } } }));
    expect(Object.keys(files).sort()).toEqual([`/assets/${ID}.png`, "/cover/back.jpg"]);
    const data = JSON.parse(new TextDecoder().decode(pdfData(input(), { mirrorMargins: false, chaptersOnRecto: false }))) as { meta: { assets: Record<string, string>; cover: { front: string } } };
    expect(data.meta.assets).toEqual({ [ID]: "png" });
    expect(data.meta.cover.front).toBe("");
  });
});
