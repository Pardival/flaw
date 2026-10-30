import { strToU8, zipSync, type Zippable } from "fflate";

import { alignOf, extensionOf, imageAttrs, plainText, runsOf, xml, type ExportInput, type PMJson } from "../model.ts";

/**
 * EPUB 3 maison (A-016) : un fichier XHTML par chapitre (roman) ou un seul (document,
 * page blanche), table des matières nav.xhtml, styles du mode. Tout le texte est échappé.
 */
function inline(node: PMJson): string {
  return runsOf(node)
    .map((run) => {
      if (run.lineBreak) {
        return "<br/>";
      }
      let html = xml(run.text);
      if (run.italic) html = `<em>${html}</em>`;
      if (run.bold) html = `<strong>${html}</strong>`;
      if (run.sizePt !== null) html = `<span style="font-size:${String(run.sizePt)}pt">${html}</span>`;
      return html;
    })
    .join("");
}

function alignClass(node: PMJson): string {
  const align = alignOf(node);
  return align === null ? "" : ` class="align-${align}"`;
}

function block(node: PMJson, input: ExportInput): string {
  switch (node.type) {
    case "image": {
      const attrs = imageAttrs(node);
      const asset = attrs ? input.assets?.[attrs.asset] : undefined;
      if (!attrs || !asset) return "";
      return `<figure class="image align-${attrs.align}"><img src="images/${attrs.asset}.${extensionOf(asset)}" alt="${xml(attrs.alt)}" style="width:${String(attrs.width)}%"/></figure>`;
    }
    case "chapter_title":
      return `<h1${alignClass(node)}>${inline(node)}</h1>`;
    case "heading": {
      const level = node.attrs?.level === 2 || node.attrs?.level === 3 ? Number(node.attrs.level) : 1;
      return `<h${String(level + 1)}${alignClass(node)}>${inline(node)}</h${String(level + 1)}>`;
    }
    case "scene_break":
      return `<p class="scene-break">*&#160;&#160;*&#160;&#160;*</p>`;
    case "bullet_list":
    case "bullet_list_2":
      return `<ul>${(node.content ?? []).map((child) => block(child, input)).join("")}</ul>`;
    case "ordered_list":
    case "ordered_list_2":
      return `<ol>${(node.content ?? []).map((child) => block(child, input)).join("")}</ol>`;
    case "list_item":
    case "list_item_2":
      return `<li>${(node.content ?? []).map((child) => block(child, input)).join("")}</li>`;
    case "title":
      return "";
    default:
      return `<p class="${xml(node.type)}${alignOf(node) ? ` align-${alignOf(node) ?? ""}` : ""}">${inline(node)}</p>`;
  }
}

type Chapter = { title: string; blocks: PMJson[] };

function chapters(input: ExportInput): Chapter[] {
  const list: Chapter[] = [];
  let current: Chapter = { title: input.title, blocks: [] };
  for (const node of input.doc.content ?? []) {
    if (input.mode === "novel" && node.type === "chapter_title") {
      if (current.blocks.length > 0) {
        list.push(current);
      }
      current = { title: plainText(node).trim() || `Chapitre ${String(list.length + 1)}`, blocks: [node] };
    } else {
      current.blocks.push(node);
    }
  }
  if (current.blocks.length > 0 || list.length === 0) {
    list.push(current);
  }
  return list;
}

function page(title: string, lang: string, body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${xml(lang)}" lang="${xml(lang)}">
<head><meta charset="UTF-8"/><title>${xml(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>${body}</body>
</html>
`;
}

const STYLE = `body { font-family: serif; line-height: 1.45; margin: 0 5%; hyphens: auto; -epub-hyphens: auto; }
p { margin: 0; text-indent: 1.4em; text-align: justify; }
h1 + p, .scene-break + p, .title-page p { text-indent: 0; }
h1 { font-size: 1.6em; text-align: center; margin: 3em 0 1.5em; page-break-before: always; font-weight: normal; }
h2, h3, h4 { font-weight: 600; margin: 1.2em 0 0.5em; }
.document p, .blank p { text-indent: 0; margin: 0 0 0.6em; text-align: left; }
.scene-break { text-align: center; text-indent: 0; margin: 1em 0; }
.title-page { text-align: center; margin-top: 30%; }
.title-page h1 { page-break-before: auto; font-size: 2em; }
figure.image { margin: 1em 0; text-indent: 0; text-align: center; } figure.image img { max-width: 100%; height: auto; }
figure.align-left { text-align: left; } figure.align-right { text-align: right; }
.cover { margin: 0; padding: 0; text-align: center; } .cover img { max-width: 100%; max-height: 100vh; }
.align-left { text-align: left; } .align-center { text-align: center; } .align-right { text-align: right; } .align-justify { text-align: justify; }
`;

/** EPUB 3 (roman, document, page blanche — AC-047). `id` : identifiant stable du texte. */
export function exportEpub(input: ExportInput, id: string, modified = new Date()): Uint8Array {
  const parts = chapters(input);
  const lang = input.lang || "fr";
  const files: Zippable = {
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
`),
    "OEBPS/style.css": strToU8(STYLE),
    "OEBPS/title.xhtml": strToU8(
      page(input.title, lang, `<section class="title-page" epub:type="titlepage"><h1>${xml(input.title)}</h1>${input.author ? `<p>${xml(input.author)}</p>` : ""}</section>`),
    ),
  };
  const manifest: string[] = [
    `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    `<item id="css" href="style.css" media-type="text/css"/>`,
    `<item id="title" href="title.xhtml" media-type="application/xhtml+xml"/>`,
  ];
  const spine: string[] = [`<itemref idref="title"/>`];
  const used = new Set<string>();
  const collect = (nodes: PMJson[]) => {
    for (const node of nodes) {
      const attrs = node.type === "image" ? imageAttrs(node) : null;
      if (attrs) used.add(attrs.asset);
      collect(node.content ?? []);
    }
  };
  collect(input.doc.content ?? []);
  for (const id of used) {
    const asset = input.assets?.[id];
    if (!asset) continue;
    const ext = extensionOf(asset);
    files[`OEBPS/images/${id}.${ext}`] = [asset.bytes, { level: 0 }];
    manifest.push(`<item id="img-${id}" href="images/${id}.${ext}" media-type="image/${asset.kind}"/>`);
  }
  if (input.cover?.front) {
    const ext = extensionOf(input.cover.front);
    files[`OEBPS/images/cover.${ext}`] = [input.cover.front.bytes, { level: 0 }];
    manifest.push(`<item id="cover-image" href="images/cover.${ext}" media-type="image/${input.cover.front.kind}" properties="cover-image"/>`);
    files["OEBPS/cover.xhtml"] = strToU8(page(input.title, lang, `<section class="cover" epub:type="cover"><img src="images/cover.${ext}" alt="${xml(input.title)}"/></section>`));
    manifest.push(`<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>`);
    spine.unshift(`<itemref idref="cover"/>`);
  }
  const toc: string[] = [];
  parts.forEach((chapter, index) => {
    const name = `chapter-${String(index + 1).padStart(3, "0")}.xhtml`;
    files[`OEBPS/${name}`] = strToU8(page(chapter.title, lang, `<section class="${xml(input.mode)}">${chapter.blocks.map((node) => block(node, input)).join("\n")}</section>`));
    manifest.push(`<item id="c${String(index + 1)}" href="${name}" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="c${String(index + 1)}"/>`);
    toc.push(`<li><a href="${name}">${xml(chapter.title)}</a></li>`);
  });
  files["OEBPS/nav.xhtml"] = strToU8(page(input.title, lang, `<nav epub:type="toc" id="toc"><h2>Sommaire</h2><ol>${toc.join("")}</ol></nav>`));
  files["OEBPS/content.opf"] = strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xml:lang="${xml(lang)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:${xml(id)}</dc:identifier>
    <dc:title>${xml(input.title)}</dc:title>
    <dc:language>${xml(lang)}</dc:language>
    ${input.author ? `<dc:creator>${xml(input.author)}</dc:creator>` : ""}
    <meta property="dcterms:modified">${modified.toISOString().replace(/\.\d{3}Z$/u, "Z")}</meta>
  </metadata>
  <manifest>
    ${manifest.join("\n    ")}
  </manifest>
  <spine>
    ${spine.join("\n    ")}
  </spine>
</package>
`);
  return zipSync(files, { level: 9 });
}
