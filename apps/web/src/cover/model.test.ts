import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { coverAssets, defaultCover, readCover, writeCover } from "./model.ts";

describe("couverture dans le texte", () => {
  it("s'enregistre dans les métadonnées et se relit", () => {
    const doc = new Y.Doc();
    expect(readCover(doc)).toBeNull();
    const cover = { ...defaultCover("Le Cartographe"), author: "Élias", backText: "Un homme qui croyait se connaître.", palette: "sea" as const };
    writeCover(doc, cover);
    expect(readCover(doc)).toEqual(cover);
    writeCover(doc, null);
    expect(readCover(doc)).toBeNull();
  });

  it("assainit une couverture venue d'ailleurs (valeurs inconnues, image hors empreinte)", () => {
    const doc = new Y.Doc();
    doc.getMap("meta").set("cover", {
      template: "<script>",
      palette: "rose",
      font: "Comic Sans",
      title: "x".repeat(500),
      author: 42,
      image: { asset: "https://exemple.fr/a.png", original: null, crop: null },
      backText: "y".repeat(5000),
    });
    const cover = readCover(doc);
    expect(cover).toMatchObject({ template: "classic", palette: "paper", font: "EB Garamond", author: "", image: null, backShowTitle: true });
    expect(cover?.title.length).toBe(200);
    expect(cover?.backText.length).toBe(1500);
  });

  it("garde l'image recadrée et son original parmi les fichiers utilisés", () => {
    const a = "a".repeat(32);
    const b = "b".repeat(32);
    expect(coverAssets({ ...defaultCover("T"), image: { asset: a, original: b, crop: [0, 0, 0.5, 0.5] } })).toEqual([a, b]);
    expect(coverAssets(null)).toEqual([]);
  });
});
