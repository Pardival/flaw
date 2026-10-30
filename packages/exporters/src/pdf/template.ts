import { DEFAULT_FONT, DEFAULT_SIZE, MARGINS_MM, PAGE_MM, SCRIPT_MARGINS_MM, extensionOf, type ExportInput } from "../model.ts";

/**
 * PDF Typst (A-016) : le gabarit lit le texte depuis /data.json. Le contenu n'est
 * jamais interpolé dans le source Typst : une chaîne JSON s'affiche telle quelle,
 * sans interprétation (pas d'injection de balisage ou de code).
 */
export type PdfOptions = { mirrorMargins: boolean; chaptersOnRecto: boolean };

/** Polices PDF : TTF statiques officiels (assets/fonts/pdf), un fichier par graisse et style. */
export const PDF_FONT_FILES: Record<string, string[]> = {
  "EB Garamond": ["EBGaramond-Regular.ttf", "EBGaramond-Italic.ttf", "EBGaramond-Bold.ttf", "EBGaramond-BoldItalic.ttf"],
  "Courier Prime": ["CourierPrime-Regular.ttf", "CourierPrime-Italic.ttf", "CourierPrime-Bold.ttf", "CourierPrime-BoldItalic.ttf"],
  Inter: ["Inter-Regular.ttf", "Inter-Italic.ttf", "Inter-Bold.ttf", "Inter-BoldItalic.ttf"],
  "Source Serif 4": ["SourceSerif4-Regular.ttf", "SourceSerif4-Italic.ttf", "SourceSerif4-Bold.ttf", "SourceSerif4-BoldItalic.ttf"],
  "Libre Baskerville": ["LibreBaskerville-Regular.ttf", "LibreBaskerville-Italic.ttf", "LibreBaskerville-Bold.ttf"],
  "Crimson Pro": ["CrimsonPro-Regular.ttf", "CrimsonPro-Italic.ttf", "CrimsonPro-Bold.ttf", "CrimsonPro-BoldItalic.ttf"],
  Literata: ["Literata-Regular.ttf", "Literata-Italic.ttf", "Literata-Bold.ttf", "Literata-BoldItalic.ttf"],
  Lora: ["Lora-Regular.ttf", "Lora-Italic.ttf", "Lora-Bold.ttf", "Lora-BoldItalic.ttf"],
  "Source Sans 3": ["SourceSans3-Regular.ttf", "SourceSans3-Italic.ttf", "SourceSans3-Bold.ttf", "SourceSans3-BoldItalic.ttf"],
  "IBM Plex Sans": ["IBMPlexSans-Regular.ttf", "IBMPlexSans-Italic.ttf", "IBMPlexSans-Bold.ttf", "IBMPlexSans-BoldItalic.ttf"],
};

/** Police du texte et repli (Source Serif 4 couvre U+202F). */
export function pdfFonts(input: ExportInput): string[] {
  const main = input.mode === "screenplay" ? "Courier Prime" : (input.fontFamily ?? DEFAULT_FONT[input.mode]);
  return [...new Set([main, "Source Serif 4"])].filter((family) => PDF_FONT_FILES[family] !== undefined);
}

/**
 * Fichiers binaires à monter à côté du gabarit : images (/assets/<empreinte>.<ext>)
 * et couvertures (/cover/front.<ext>, /cover/back.<ext>). Les chemins viennent
 * d'empreintes hexadécimales contrôlées, jamais du texte.
 */
export function pdfFiles(input: ExportInput): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  for (const [id, asset] of Object.entries(input.assets ?? {})) {
    if (/^[0-9a-f]{32}$/u.test(id)) files[`/assets/${id}.${extensionOf(asset)}`] = asset.bytes;
  }
  if (input.cover?.front) files[`/cover/front.${extensionOf(input.cover.front)}`] = input.cover.front.bytes;
  if (input.cover?.back) files[`/cover/back.${extensionOf(input.cover.back)}`] = input.cover.back.bytes;
  return files;
}

export function pdfData(input: ExportInput, options: PdfOptions): Uint8Array {
  const page = PAGE_MM[input.pageFormat];
  const margins = input.mode === "screenplay" ? SCRIPT_MARGINS_MM : MARGINS_MM[input.pageFormat];
  const novel = input.mode === "novel";
  const data = {
    meta: {
      title: input.title,
      author: input.author ?? "",
      mode: input.mode,
      lang: (input.lang || "fr").slice(0, 2),
      font: input.mode === "screenplay" ? "Courier Prime" : (input.fontFamily ?? DEFAULT_FONT[input.mode]),
      size: input.mode === "screenplay" ? 12 : (input.baseFontSizePt ?? DEFAULT_SIZE[input.mode]),
      justify: novel,
      mirror: novel && options.mirrorMargins,
      recto: novel && options.chaptersOnRecto,
      titlePage: novel || input.mode === "screenplay",
      page: { width: page.width, height: page.height, margins },
      assets: Object.fromEntries(Object.entries(input.assets ?? {}).map(([id, asset]) => [id, extensionOf(asset)])),
      cover: {
        front: input.cover?.front ? `/cover/front.${extensionOf(input.cover.front)}` : "",
        back: input.cover?.back ? `/cover/back.${extensionOf(input.cover.back)}` : "",
      },
    },
    doc: input.doc,
  };
  return new TextEncoder().encode(JSON.stringify(data));
}

export const TYPST_MAIN = String.raw`
#let data = json("/data.json")
#let meta = data.meta
#let m = meta.page.margins
#let script = meta.mode == "screenplay"
#let novel = meta.mode == "novel"
// La 1re de couverture n'entre pas dans la pagination du livre.
#let offset = if meta.cover.front != "" { 1 } else { 0 }

#set document(title: meta.title)
#set text(font: (meta.font, "Source Serif 4"), size: meta.size * 1pt, lang: meta.lang, hyphenate: not script)
#set par(justify: meta.justify, leading: if script { 0.5em } else { 0.62em }, spacing: if novel { 0.62em } else { 0.9em },
  first-line-indent: if novel { (amount: 1.4em, all: false) } else { 0pt })

#let chapter-title-at(loc) = {
  let before = query(heading.where(level: 1).before(loc))
  if before.len() == 0 { "" } else { before.last().body }
}

#set page(
  width: meta.page.width * 1mm,
  height: meta.page.height * 1mm,
  margin: if meta.mirror {
    (top: m.at(0) * 1mm, outside: m.at(1) * 1mm, bottom: m.at(2) * 1mm, inside: m.at(3) * 1mm)
  } else {
    (top: m.at(0) * 1mm, right: m.at(1) * 1mm, bottom: m.at(2) * 1mm, left: m.at(3) * 1mm)
  },
  header: context {
    if novel {
      let page-here = here().page()
      let opening = query(heading.where(level: 1)).any(h => h.location().page() == page-here)
      if not opening and page-here - offset > 2 {
        align(center, text(size: 8.5pt, smallcaps(chapter-title-at(here()))))
      }
    }
  },
  footer: context {
    if here().page() - offset > 1 or not meta.titlePage { align(center, text(size: 9pt, counter(page).display())) }
  },
)

#show heading.where(level: 1): it => if novel {
  set align(center)
  set text(size: 20pt, weight: "regular")
  v(3em)
  it.body
  v(1.5em)
} else { it }

#let styled(body, marks) = {
  let r = body
  for mark in marks {
    if mark.type == "bold" { r = strong(r) }
    else if mark.type == "italic" { r = emph(r) }
    else if mark.type == "font_size" { r = text(size: mark.attrs.pt * 1pt, r) }
  }
  r
}

#let inline(node) = {
  for child in node.at("content", default: ()) {
    if child.type == "text" { styled(child.text, child.at("marks", default: ())) }
    else if child.type == "hard_break" { linebreak() }
  }
}

#let aligned(node, body) = {
  let a = node.at("attrs", default: (:)).at("align", default: none)
  if a == "center" { align(center, body) }
  else if a == "right" { align(right, body) }
  else if a == "justify" { par(justify: true, body) }
  else { body }
}

#let render(node) = {
  let t = node.type
  if t == "title" { }
  else if t == "chapter_title" {
    if meta.recto { pagebreak(to: "odd", weak: true) } else { pagebreak(weak: true) }
    heading(level: 1, inline(node))
  }
  else if t == "heading" {
    let level = node.at("attrs", default: (:)).at("level", default: 1)
    aligned(node, heading(level: level, inline(node)))
  }
  else if t == "scene_break" { align(center, block(above: 1em, below: 1em, [\*#h(1em)\*#h(1em)\*])) }
  else if t == "bullet_list" or t == "bullet_list_2" {
    list(..node.at("content", default: ()).map(item => [#for c in item.at("content", default: ()) { render(c) }]))
  }
  else if t == "ordered_list" or t == "ordered_list_2" {
    enum(..node.at("content", default: ()).map(item => [#for c in item.at("content", default: ()) { render(c) }]))
  }
  else if t == "scene_heading" { block(above: 1.2em, below: 0.6em, upper(strong(inline(node)))) }
  else if t == "action" { block(above: 0.6em, below: 0.6em, inline(node)) }
  else if t == "character" { block(above: 0.6em, below: 0em, pad(left: 2.2in, upper(inline(node)))) }
  else if t == "parenthetical" { block(above: 0em, below: 0em, pad(left: 1.6in, right: 2.4in, inline(node))) }
  else if t == "dialogue" { block(above: 0em, below: 0.6em, pad(left: 1in, right: 1.5in, inline(node))) }
  else if t == "transition" { block(above: 0.6em, below: 0.6em, align(right, upper(inline(node)))) }
  else if t == "centered" { align(center, inline(node)) }
  else if t == "image" {
    let a = node.at("attrs", default: (:))
    let id = a.at("asset", default: "")
    if id in meta.assets {
      let side = if a.at("align", default: "center") == "left" { left } else if a.at("align", default: "center") == "right" { right } else { center }
      block(above: 0.8em, below: 0.8em, breakable: false, align(side, image("/assets/" + id + "." + meta.assets.at(id), width: a.at("width", default: 60) * 1%)))
    }
  }
  else { aligned(node, par(inline(node))) }
}

#let cover-page(path) = page(margin: 0pt, header: none, footer: none, image(path, width: 100%, height: 100%, fit: "cover"))

#if meta.cover.front != "" {
  cover-page(meta.cover.front)
  counter(page).update(1)
}

#if meta.titlePage {
  page(header: none, footer: none, align(center + horizon, {
    text(size: 24pt, meta.title)
    if meta.author != "" { v(1em); text(size: 13pt, meta.author) }
  }))
  if meta.recto { pagebreak(to: "odd", weak: true) }
}

#for node in data.doc.at("content", default: ()) { render(node) }

#if meta.cover.back != "" {
  pagebreak(weak: true)
  cover-page(meta.cover.back)
}
`;
