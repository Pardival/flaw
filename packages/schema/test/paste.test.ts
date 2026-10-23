import type { Node as PMNode } from "prosemirror-model";
import { describe, expect, it } from "vitest";

import { documentFromJson, parsePastedHtml, schema } from "../src/index.ts";

const XSS = [
  "<script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  '<p onclick="alert(1)">ok</p>',
  '<a href="javascript:alert(1)">lien</a>',
  '<div style="background:url(javascript:alert(1))">mot</div>',
  "<svg onload=alert(1)><script>alert(1)</script></svg>",
  '<math><mi>x</mi><mglyph><style><!--</style><img title="--&gt;&lt;img src=1 onerror=alert(1)&gt;"></math>',
  '<iframe src="javascript:alert(1)"></iframe>',
  '<object data="javascript:alert(1)"></object>',
  '<link rel="stylesheet" href="javascript:alert(1)">',
  '<b style="x:expression(alert(1))" onclick="alert(1)">gras</b>',
  '<h1 id="x" class="y" style="color:red" onclick="alert(1)">Titre</h1>',
  '<p><span onmouseover="alert(1)">suite</span></p>',
  '<img alt="caché" src="javascript:alert(1)">',
  "<p>ok<script>alert(1)</script></p>",
  "<p>avant<img src=x onerror=alert(1)>après</p>",
  "<noscript><img src=x onerror=alert(1)></noscript>",
  "<template><img src=x onerror=alert(1)></template>",
];

function types(doc: PMNode): string[] {
  const names: string[] = [];
  doc.descendants((node) => {
    if (!node.isText) names.push(node.type.name);
  });
  return names;
}

function assertClean(doc: PMNode): void {
  const allowed = new Set([...Object.keys(schema.nodes), ...Object.keys(schema.marks)]);
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const record = value as Record<string, unknown>;
    if (typeof record.type === "string") expect(allowed.has(record.type)).toBe(true);
    for (const [key, entry] of Object.entries(record)) {
      expect(key).not.toMatch(/^on/i);
      expect(["style", "href", "src", "html"]).not.toContain(key);
      if (typeof entry === "string") {
        expect(entry).not.toMatch(/javascript:/i);
        expect(entry).not.toMatch(/<script/i);
        expect(entry).not.toMatch(/\son\w+\s*=/i);
      }
      walk(entry);
    }
  };
  walk(doc.toJSON());
  expect(documentFromJson(doc.toJSON()).eq(doc)).toBe(true);
}

describe("collage filtré", () => {
  it("retire les charges XSS sans les stocker", () => {
    for (const html of XSS) {
      const doc = parsePastedHtml(html);
      assertClean(doc);
      expect(doc.textContent).not.toContain("alert(1)");
      expect(types(doc)).not.toContain("image");
      expect(types(doc)).not.toContain("script");
    }
    expect(parsePastedHtml('<a href="javascript:alert(1)">lien</a>').textContent).toBe("lien");
    expect(parsePastedHtml("<script>alert(1)</script>").textContent).toBe("");
    expect(parsePastedHtml('<img src=x onerror=alert(1) alt="caché">').textContent).toBe("");
    expect(parsePastedHtml('<p onclick="alert(1)" style="color:red">ok</p>').textContent).toBe("ok");
  });

  it("conserve le texte visible, y compris les caractères <script", () => {
    const doc = parsePastedHtml("<p>Le narrateur écrit &lt;script&gt; dans le roman.</p>");
    expect(doc.textContent).toBe("Le narrateur écrit <script> dans le roman.");
    expect(doc.child(0).type.name).toBe("paragraph");
  });

  it("produit gras, italique, taille, alignements et titres 1 à 3", () => {
    const doc = parsePastedHtml(
      '<p data-align="justify"><strong>gras</strong> <em>italique</em> <span data-font-size="14">14</span></p>' +
        '<p align="center">centré</p>' +
        '<p align="javascript:alert(1)">gauche</p>' +
        '<p style="text-align:right">sans style</p>' +
        "<h1>Un</h1><h2>Deux</h2><h3>Trois</h3><h4>Quatre</h4>" +
        '<span data-font-size="999">hors</span>' +
        '<span data-font-size="javascript:alert(1)">liste</span>',
    );
    assertClean(doc);
    const justified = doc.child(0);
    expect(justified.attrs.align).toBe("justify");
    expect(justified.firstChild?.marks.map((mark) => mark.type.name)).toEqual(["bold"]);
    const sized = justified.content.child(justified.content.childCount - 1);
    expect(sized.marks.map((mark) => mark.attrs.pt)).toEqual([14]);
    expect(doc.child(1).attrs.align).toBe("center");
    expect(doc.child(2).attrs.align).toBeNull();
    expect(doc.child(3).attrs.align).toBeNull();
    expect(doc.child(4).type.name).toBe("heading");
    expect(doc.child(4).attrs.level).toBe(1);
    expect(doc.child(5).attrs.level).toBe(2);
    expect(doc.child(6).attrs.level).toBe(3);
    expect(doc.child(7).attrs.level).toBe(3);
    let found = false;
    doc.descendants((node) => {
      if (!node.isText || !node.text?.includes("hors")) return;
      found = true;
      expect(node.marks.map((mark) => mark.type.name)).toEqual([]);
    });
    expect(found).toBe(true);
  });

  it("limite les listes à deux niveaux et sépare le titre du chapitre", () => {
    const doc = parsePastedHtml(
      '<p data-flaw-node="title">Mon livre</p>' +
        '<p data-flaw-node="chapter_title">Chapitre</p>' +
        "<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li></ul>" +
        "<ol><li>1</li><li>2</li></ol>" +
        '<p data-flaw-node="image" onclick="alert(1)">photo</p>' +
        '<p data-flaw-node="scene_heading">INT. NUIT</p>' +
        "<p>ligne<br>suivante</p><hr>",
    );
    assertClean(doc);
    expect(doc.child(0).type.name).toBe("title");
    expect(doc.child(1).type.name).toBe("chapter_title");
    expect(doc.child(0).textContent).toBe("Mon livre");
    const list = doc.child(2);
    expect(list.type.name).toBe("bullet_list");
    const item = list.child(0);
    expect(item.child(0).textContent).toBe("a");
    expect(item.lastChild?.type.name).toBe("bullet_list_2");
    const nested = item.lastChild;
    expect(nested?.child(0).type.name).toBe("list_item_2");
    expect(nested?.textContent).toContain("b");
    expect(nested?.textContent).toContain("c");
    expect(types(nested ?? item)).not.toContain("bullet_list");
    expect(doc.child(3).type.name).toBe("ordered_list");
    const photo = doc.child(4);
    expect(photo.type.name).toBe("paragraph");
    expect(photo.textContent).toBe("photo");
    expect(doc.child(5).type.name).toBe("scene_heading");
    const broken = doc.child(6);
    expect(broken.child(1).type.name).toBe("hard_break");
    expect(doc.lastChild?.type.name).toBe("scene_break");
  });

  it("aplatit une seconde liste du même élément", () => {
    const doc = parsePastedHtml("<ul><li>a<ul><li>b</li></ul><ol><li>c</li></ol></li></ul>");
    assertClean(doc);
    expect(
      types(doc).filter((name) => name === "bullet_list" || name === "ordered_list" || name.endsWith("_2")),
    ).toEqual(["bullet_list", "bullet_list_2", "list_item_2"]);
    expect(doc.textContent).toContain("a");
    expect(doc.textContent).toContain("b");
    expect(doc.textContent).toContain("c");
  });

  it("retourne un paragraphe vide quand tout est retiré", () => {
    const doc = parsePastedHtml("  <script>alert(1)</script>  ");
    expect(doc.childCount).toBe(1);
    expect(doc.child(0).type.name).toBe("paragraph");
    expect(doc.textContent).toBe("");
    doc.check();
  });
});
