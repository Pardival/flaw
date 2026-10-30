import type { Node as PMNode } from "prosemirror-model";
import { describe, expect, it } from "vitest";

import {
  ALIGNS,
  COMMON_NODES,
  DOCUMENT_MODES,
  DOCUMENT_PAGE_FORMAT,
  FONT_SIZE_PT_MAX,
  FONT_SIZE_PT_MIN,
  MODE_NODES,
  SCHEMA_VERSION,
  SCREENPLAY_DEFAULTS,
  SchemaError,
  TEXT_BLOCKS,
  documentFromJson,
  emptyDocument,
  nodesForMode,
  nodesOutsideMode,
  schema,
} from "../src/index.ts";

function text(value: string, marks?: PMNode["marks"]): PMNode {
  return schema.text(value, marks);
}

function paragraph(value: string, align: string | null = null): PMNode {
  return schema.node("paragraph", { align }, value.length > 0 ? [text(value)] : []);
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SchemaError);
    return (error as SchemaError).code;
  }
  throw new Error("exception attendue");
}

describe("schéma unique", () => {
  it("expose la version provisoire entière", () => {
    expect(SCHEMA_VERSION).toBe(2);
    expect(Number.isInteger(SCHEMA_VERSION)).toBe(true);
  });

  it("nomme les quatre modes et les nœuds d'A-018", () => {
    expect(DOCUMENT_MODES).toEqual(["novel", "screenplay", "document", "blank"]);
    expect(nodesForMode("novel")).toEqual([...COMMON_NODES, ...MODE_NODES.novel]);
    expect(nodesForMode("screenplay")).toEqual([...COMMON_NODES, ...MODE_NODES.screenplay]);
    expect(nodesForMode("document")).toEqual([...COMMON_NODES, ...MODE_NODES.document]);
    expect(nodesForMode("blank")).toEqual([...COMMON_NODES, ...MODE_NODES.blank]);
    for (const name of [
      ...COMMON_NODES,
      ...MODE_NODES.novel,
      ...MODE_NODES.screenplay,
      ...MODE_NODES.document,
      ...MODE_NODES.blank,
      ...TEXT_BLOCKS,
    ]) {
      expect(schema.nodes[name]).toBeDefined();
    }
  });

  it("sérialise sans style, href, src ni gestionnaire", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", { align: "center" }, [
        schema.text("a", [schema.marks.bold.create(), schema.marks.font_size.create({ pt: 12 })]),
      ]),
      schema.node("heading", { level: 1, align: "right" }, [schema.text("T")]),
      schema.node("scene_break"),
    ]);
    const specs: unknown[] = [];
    doc.descendants((node) => {
      const render = node.type.spec.toDOM;
      if (typeof render === "function") specs.push(render(node));
      for (const mark of node.marks) {
        const renderMark = mark.type.spec.toDOM;
        if (typeof renderMark === "function") specs.push(renderMark(mark, true));
      }
    });
    const flat = JSON.stringify(specs);
    expect(flat).not.toMatch(/"style"|"href"|"src"|"on[a-z]+"/);
    expect(flat).toContain("data-align");
    expect(flat).toContain("data-font-size");
    expect(flat).toContain("strong");
  });

  it("n'a ni lien ni parseDOM ; l'image ne désigne qu'un fichier du texte", () => {
    expect(schema.nodes.link).toBeUndefined();
    expect(Object.keys(schema.nodes.image?.spec.attrs ?? {}).sort()).toEqual(["align", "alt", "asset", "crop", "original", "ratio", "width"]);
    expect(Object.keys(schema.marks).sort()).toEqual(["bold", "font_size", "italic"]);
    for (const node of Object.values(schema.nodes)) {
      expect(node.spec.parseDOM).toBeUndefined();
      const attrs = Object.keys(node.spec.attrs ?? {});
      expect(attrs).not.toContain("href");
      expect(attrs).not.toContain("src");
      expect(attrs).not.toContain("style");
    }
    for (const mark of Object.values(schema.marks)) {
      expect(mark.spec.parseDOM).toBeUndefined();
    }
  });

  it("distingue le titre du livre des titres de chapitre", () => {
    const doc = schema.node("doc", null, [
      schema.node("title", { align: null }, [text("Mon livre")]),
      schema.node("chapter_title", { align: null }, [text("I")]),
      paragraph("Suite."),
    ]);
    doc.check();
    expect(doc.child(0).type.name).toBe("title");
    expect(doc.child(1).type.name).toBe("chapter_title");
    expect(doc.child(0).type).not.toBe(doc.child(1).type);
  });

  it("accepte les quatre alignements et la taille locale", () => {
    expect(ALIGNS).toEqual(["left", "center", "right", "justify"]);
    const bold = schema.marks.bold.create();
    const italic = schema.marks.italic.create();
    const size = schema.marks.font_size.create({ pt: 14 });
    const doc = schema.node("doc", null, [
      schema.node("paragraph", { align: "justify" }, [text("texte", [bold, italic, size])]),
      schema.node("heading", { level: 2, align: "center" }, [text("Partie")]),
    ]);
    doc.check();
    expect(doc.child(0).attrs.align).toBe("justify");
    expect(doc.child(1).attrs.level).toBe(2);
    expect(doc.child(0).textContent).toBe("texte");
  });

  it("garde un document mêlé valide, et signale les nœuds hors mode", () => {
    const doc = schema.node("doc", null, [
      schema.node("chapter_title", { align: null }, [text("I")]),
      paragraph("Roman."),
      schema.node("scene_heading", { align: null }, [text("INT. GARE")]),
      schema.node("heading", { level: 1, align: null }, [text("Note")]),
      schema.node("bullet_list", null, [
        schema.node("list_item", null, [
          paragraph("un"),
          schema.node("ordered_list_2", null, [
            schema.node("list_item_2", null, [paragraph("deux")]),
          ]),
        ]),
      ]),
    ]);
    const read = documentFromJson(doc.toJSON());
    expect(read.eq(doc)).toBe(true);
    expect(nodesOutsideMode(doc, "novel")).toEqual([
      "bullet_list",
      "heading",
      "list_item",
      "list_item_2",
      "ordered_list_2",
      "scene_heading",
    ]);
    expect(nodesOutsideMode(doc, "screenplay")).toEqual([
      "bullet_list",
      "chapter_title",
      "heading",
      "list_item",
      "list_item_2",
      "ordered_list_2",
      "paragraph",
    ]);
    expect(nodesOutsideMode(emptyDocument("blank"), "blank")).toEqual([]);
  });

  it("ouvre chaque mode sur un document valide de ce seul mode", () => {
    expect(emptyDocument("novel").child(0).type.name).toBe("chapter_title");
    expect(emptyDocument("screenplay").child(0).type.name).toBe("scene_heading");
    expect(emptyDocument("document").child(0).type.name).toBe("paragraph");
    expect(emptyDocument("blank").child(0).type.name).toBe("paragraph");
    for (const mode of DOCUMENT_MODES) {
      const doc = emptyDocument(mode);
      expect(nodesOutsideMode(doc, mode)).toEqual([]);
      expect(documentFromJson(doc.toJSON()).eq(doc)).toBe(true);
    }
  });

  it("donne les défauts du script et le format A4 du document", () => {
    expect(SCREENPLAY_DEFAULTS).toEqual({
      fontFamily: "Courier Prime",
      baseFontSizePt: 12,
      pageFormat: "us_letter",
    });
    expect(DOCUMENT_PAGE_FORMAT).toBe("a4");
    expect(FONT_SIZE_PT_MIN).toBeLessThan(SCREENPLAY_DEFAULTS.baseFontSizePt);
    expect(FONT_SIZE_PT_MAX).toBeGreaterThan(SCREENPLAY_DEFAULTS.baseFontSizePt);
  });
});

describe("lecture JSON", () => {
  const stored = {
    type: "doc",
    content: [{ type: "paragraph", attrs: { align: null } }],
  };

  it("rejette un nœud, une marque ou un attribut inconnu", () => {
    expect(codeOf(() => documentFromJson({ type: "doc", content: [{ type: "video" }] }))).toBe(
      "unknown_node",
    );
    expect(
      codeOf(() =>
        documentFromJson({
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "a", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }],
            },
          ],
        }),
      ),
    ).toBe("unknown_mark");
    expect(
      codeOf(() =>
        documentFromJson({
          type: "doc",
          content: [{ type: "paragraph", attrs: { align: "left", style: "color:red", onclick: "alert(1)" } }],
        }),
      ),
    ).toBe("unknown_attr");
    expect(
      codeOf(() =>
        documentFromJson({
          type: "doc",
          html: "<script>alert(1)</script>",
          content: [{ type: "paragraph" }],
        }),
      ),
    ).toBe("invalid_json");
  });

  it("rejette un niveau, un alignement ou une taille hors liste", () => {
    expect(
      codeOf(() =>
        documentFromJson({
          type: "doc",
          content: [{ type: "heading", attrs: { level: 4, align: null } }],
        }),
      ),
    ).toBe("invalid_attr");
    expect(
      codeOf(() =>
        documentFromJson({
          type: "doc",
          content: [{ type: "paragraph", attrs: { align: "javascript:alert(1)" } }],
        }),
      ),
    ).toBe("invalid_attr");
    expect(
      codeOf(() =>
        documentFromJson({
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "a", marks: [{ type: "font_size", attrs: { pt: FONT_SIZE_PT_MAX + 1 } }] },
              ],
            },
          ],
        }),
      ),
    ).toBe("invalid_attr");
    expect(documentFromJson(stored).child(0).attrs.align).toBeNull();
  });

  it("rejette une liste au-delà de deux niveaux", () => {
    const third = {
      type: "doc",
      content: [
        {
          type: "bullet_list",
          content: [
            {
              type: "list_item",
              content: [
                { type: "paragraph" },
                {
                  type: "bullet_list_2",
                  content: [
                    {
                      type: "list_item_2",
                      content: [
                        { type: "paragraph" },
                        {
                          type: "bullet_list",
                          content: [{ type: "list_item", content: [{ type: "paragraph" }] }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(codeOf(() => documentFromJson(third))).toBe("invalid_content");
  });

  it("accepte une liste à deux niveaux et un saut de ligne", () => {
    const doc = schema.node("doc", null, [
      schema.node("ordered_list", null, [
        schema.node("list_item", null, [
          paragraph("un"),
          schema.node("bullet_list_2", null, [schema.node("list_item_2", null, [paragraph("sous")])]),
        ]),
      ]),
      schema.node("paragraph", { align: "left" }, [
        text("ligne"),
        schema.node("hard_break"),
        text("suite"),
      ]),
      schema.node("scene_break"),
    ]);
    expect(documentFromJson(doc.toJSON()).eq(doc)).toBe(true);
  });
});

describe("image", () => {
  const asset = "0123456789abcdef0123456789abcdef";
  const image = (attrs: Record<string, unknown>) => ({ type: "doc", content: [{ type: "image", attrs }] });

  it("accepte une image du texte, avec taille, rapport, alignement et recadrage", () => {
    const doc = documentFromJson(image({ asset, original: asset, width: 80, ratio: 0.5, align: "left", crop: [0.1, 0.2, 0.5, 0.4], alt: "Carte" }));
    expect(doc.firstChild?.attrs).toMatchObject({ asset, width: 80, ratio: 0.5, align: "left" });
  });

  it("refuse toute URL, chemin ou valeur hors bornes", () => {
    for (const attrs of [
      { asset: "https://exemple.fr/a.png" },
      { asset: "../../etc/passwd" },
      { asset, width: 5 },
      { asset, width: 120 },
      { asset, ratio: 0 },
      { asset, align: "justify" },
      { asset, crop: [0.5, 0, 0.6, 1] },
      { asset, alt: "x".repeat(501) },
      { asset, src: asset },
    ]) {
      expect(["invalid_attr", "unknown_attr"]).toContain(codeOf(() => documentFromJson(image(attrs))));
    }
  });
});
