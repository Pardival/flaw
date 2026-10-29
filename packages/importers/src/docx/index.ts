import type { SaxesTagPlain } from "saxes";

import { suggestMode, type Block, type ImportResult, type Run } from "../blocks.ts";
import { fail } from "../errors.ts";
import { LIMITS } from "../limits.ts";
import { extract, readDirectory, type ZipEntry } from "../zip.ts";
import { attr, parseXml } from "../xml.ts";

/**
 * Import .docx maison (T-038) : liste blanche des parties, contrôles de type,
 * styles de titres, listes, texte masqué retiré, notes reportées en fin de texte,
 * relations externes ignorées. Liens et images non conservés (AC-076).
 */
const MAIN = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const MACRO = "application/vnd.ms-word.document.macroEnabled.main+xml";
const TEMPLATE = "application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml";
const MACRO_TEMPLATE = "application/vnd.ms-word.template.macroEnabledTemplate.main+xml";
const STRICT_NS = "http://purl.oclc.org/ooxml/wordprocessingml/main";

type Style = { heading?: 1 | 2 | 3; vanish?: boolean; title?: boolean; bold?: boolean; italic?: boolean };

function on(tag: SaxesTagPlain): boolean {
  const value = attr(tag, "w:val");
  return value === undefined || !["0", "false", "off", "none"].includes(value.toLowerCase());
}

function partPath(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const folder = base.includes("/") ? base.slice(0, base.lastIndexOf("/") + 1) : "";
  const parts = `${folder}${target}`.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "..") out.pop();
    else if (part !== "." && part !== "") out.push(part);
  }
  return out.join("/");
}

export function importDocx(bytes: Uint8Array, fileName: string): ImportResult {
  if (bytes.length > LIMITS.docxFileBytes) fail("too_large");
  const entries = readDirectory(bytes);
  const names = [...entries.keys()].map((name) => name.toLowerCase());
  if (names.some((name) => name.endsWith("vbaproject.bin") || name.endsWith("vbadata.xml"))) fail("macro");
  const budget = { used: 0 };
  const read = (name: string): Uint8Array | undefined => {
    const entry: ZipEntry | undefined = entries.get(name);
    return entry === undefined ? undefined : extract(bytes, entry, budget);
  };

  // [Content_Types].xml : la partie principale doit être un document Word classique.
  const types = read("[Content_Types].xml");
  if (types === undefined) fail("not_zip");
  let main: string | undefined;
  let mainType: string | undefined;
  parseXml(types, {
    open: (tag) => {
      if (tag.name === "Override") {
        const type = attr(tag, "ContentType");
        if (type === MAIN || type === MACRO || type === TEMPLATE || type === MACRO_TEMPLATE) {
          main = attr(tag, "PartName")?.replace(/^\//u, "");
          mainType = type;
        }
      }
    },
    close: () => undefined,
    text: () => undefined,
  });
  if (mainType === MACRO || mainType === MACRO_TEMPLATE) fail("macro");
  if (mainType === TEMPLATE) fail("template");
  if (main === undefined) fail("main_part");

  // _rels/.rels doit désigner la même partie principale (C6).
  const rootRels = read("_rels/.rels");
  let official: string | undefined;
  if (rootRels) {
    parseXml(rootRels, {
      open: (tag) => {
        if (tag.name === "Relationship" && (attr(tag, "Type") ?? "").endsWith("/officeDocument") && attr(tag, "TargetMode") !== "External") {
          official = partPath("", attr(tag, "Target") ?? "");
        }
      },
      close: () => undefined,
      text: () => undefined,
    });
  }
  if (official !== main) fail("main_part");
  const mainPath = main as string;

  // Relations du document : externes ignorées (comptées), notes localisées.
  let externalLinks = 0;
  let footnotesPart: string | undefined;
  const relsPath = partPath(mainPath, `_rels/${mainPath.split("/").pop() ?? ""}.rels`);
  const docRels = read(relsPath);
  if (docRels) {
    parseXml(docRels, {
      open: (tag) => {
        if (tag.name !== "Relationship") return;
        if (attr(tag, "TargetMode") === "External") {
          externalLinks += 1;
          return;
        }
        const type = attr(tag, "Type") ?? "";
        if (type.endsWith("/footnotes")) footnotesPart = partPath(mainPath, attr(tag, "Target") ?? "");
        if (type.endsWith("/attachedTemplate")) externalLinks += 0;
      },
      close: () => undefined,
      text: () => undefined,
    });
  }

  // Styles : titres (outlineLvl, Heading1…3, Titre1…3, Title) et texte masqué.
  const styles = new Map<string, Style>();
  const stylesPart = read(partPath(mainPath, "styles.xml"));
  if (stylesPart) {
    let current: { id: string; style: Style } | null = null;
    let inRunProps = false;
    parseXml(stylesPart, {
      open: (tag) => {
        if (tag.name === "w:style") {
          const id = attr(tag, "w:styleId") ?? "";
          const match = /^(?:heading|titre|berschrift|título|titolo)\s*([1-3])$/iu.exec(id) ?? /^(?:Heading|Titre)([1-3])$/u.exec(id);
          current = { id, style: {} };
          if (match) current.style.heading = Number(match[1]) as 1 | 2 | 3;
          if (/^(title|titre)$/iu.test(id)) current.style.title = true;
        } else if (current !== null) {
          if (tag.name === "w:name") {
            const name = attr(tag, "w:val") ?? "";
            const match = /^(?:heading|titre)\s*([1-3])$/iu.exec(name);
            if (match) current.style.heading = Number(match[1]) as 1 | 2 | 3;
            if (/^(title|titre)$/iu.test(name)) current.style.title = true;
          } else if (tag.name === "w:outlineLvl") {
            const level = Number(attr(tag, "w:val"));
            if (level >= 0 && level <= 2) current.style.heading = (level + 1) as 1 | 2 | 3;
          } else if (tag.name === "w:rPr") {
            inRunProps = true;
          } else if (inRunProps && tag.name === "w:vanish") {
            current.style.vanish = on(tag);
          } else if (inRunProps && tag.name === "w:b") {
            current.style.bold = on(tag);
          } else if (inRunProps && tag.name === "w:i") {
            current.style.italic = on(tag);
          }
        }
      },
      close: (name) => {
        if (name === "w:rPr") inRunProps = false;
        if (name === "w:style" && current !== null) {
          styles.set(current.id, current.style);
          current = null;
        }
      },
      text: () => undefined,
    });
  }

  // Listes : numId → format du niveau 0/1 (puce ou numéro).
  const ordered = new Map<string, Map<number, boolean>>();
  const numberingPart = read(partPath(mainPath, "numbering.xml"));
  if (numberingPart) {
    const abstracts = new Map<string, Map<number, boolean>>();
    const nums = new Map<string, string>();
    let abstractId: string | null = null;
    let level = 0;
    let numId: string | null = null;
    parseXml(numberingPart, {
      open: (tag) => {
        if (tag.name === "w:abstractNum") {
          abstractId = attr(tag, "w:abstractNumId") ?? null;
          if (abstractId !== null) abstracts.set(abstractId, new Map());
        } else if (tag.name === "w:lvl") {
          level = Number(attr(tag, "w:ilvl") ?? "0");
        } else if (tag.name === "w:numFmt" && abstractId !== null) {
          abstracts.get(abstractId)?.set(level, attr(tag, "w:val") !== "bullet");
        } else if (tag.name === "w:num") {
          numId = attr(tag, "w:numId") ?? null;
        } else if (tag.name === "w:abstractNumId" && numId !== null) {
          nums.set(numId, attr(tag, "w:val") ?? "");
        }
      },
      close: (name) => {
        if (name === "w:abstractNum") abstractId = null;
        if (name === "w:num") numId = null;
      },
      text: () => undefined,
    });
    for (const [id, abstract] of nums) {
      ordered.set(id, abstracts.get(abstract) ?? new Map());
    }
  }

  let invisible = 0;
  const footnoteTexts = new Map<string, Run[]>();
  const footnoteOrder: string[] = [];

  /** Paragraphes d'une partie (document ou notes), zones de texte comprises. */
  const paragraphs = (part: Uint8Array, onParagraph: (block: Block, noteId: string | null) => void): void => {
    type Para = { runs: Run[]; style?: Style; num?: { id: string; level: number }; align?: "left" | "center" | "right" | "justify" };
    const stack: Para[] = [];
    let run: { bold?: boolean; italic?: boolean; hidden?: boolean; tiny?: boolean; white?: boolean; style?: Style } | null = null;
    let inRunProps = false;
    let inParaProps = false;
    let textOpen = false;
    let deleted = 0;
    let instr = 0;
    let noteId: string | null = null;
    let numId: string | null = null;
    let numLevel = 0;
    parseXml(part, {
      open: (tag) => {
        switch (tag.name) {
          case "w:footnote":
            noteId = attr(tag, "w:id") ?? null;
            break;
          case "w:p":
            stack.push({ runs: [] });
            break;
          case "w:pPr":
            inParaProps = true;
            break;
          case "w:pStyle": {
            const para = stack[stack.length - 1];
            if (para && inParaProps) para.style = styles.get(attr(tag, "w:val") ?? "");
            break;
          }
          case "w:jc": {
            const para = stack[stack.length - 1];
            const value = attr(tag, "w:val");
            if (para && inParaProps && !inRunProps) {
              para.align = value === "center" ? "center" : value === "right" || value === "end" ? "right" : value === "both" || value === "distribute" ? "justify" : undefined;
            }
            break;
          }
          case "w:numId":
            numId = attr(tag, "w:val") ?? null;
            break;
          case "w:ilvl":
            numLevel = Number(attr(tag, "w:val") ?? "0");
            break;
          case "w:r":
            run = {};
            break;
          case "w:rPr":
            inRunProps = true;
            break;
          case "w:rStyle":
            if (run) run.style = styles.get(attr(tag, "w:val") ?? "");
            break;
          case "w:b":
            if (run && inRunProps) run.bold = on(tag);
            break;
          case "w:i":
            if (run && inRunProps) run.italic = on(tag);
            break;
          case "w:vanish":
          case "w:specVanish":
            if (run && inRunProps) run.hidden = on(tag);
            break;
          case "w:sz":
            if (run && inRunProps && Number(attr(tag, "w:val") ?? "24") <= 2) run.tiny = true;
            break;
          case "w:color":
            if (run && inRunProps && /^(fff|ffffff)$/iu.test(attr(tag, "w:val") ?? "")) run.white = true;
            break;
          case "w:t":
            textOpen = true;
            break;
          case "w:delText":
          case "w:del":
            deleted += 1;
            break;
          case "w:instrText":
            instr += 1;
            break;
          case "w:tab":
            if (run && !inRunProps) stack[stack.length - 1]?.runs.push({ text: " " });
            break;
          case "w:br":
          case "w:cr":
            if (run && !inRunProps) stack[stack.length - 1]?.runs.push({ text: "", br: true });
            break;
          case "w:footnoteReference": {
            const id = attr(tag, "w:id") ?? "";
            if (!footnoteOrder.includes(id)) footnoteOrder.push(id);
            stack[stack.length - 1]?.runs.push({ text: `[${String(footnoteOrder.indexOf(id) + 1)}]` });
            break;
          }
          default:
            break;
        }
      },
      close: (name) => {
        switch (name) {
          case "w:pPr":
            inParaProps = false;
            if (numId !== null && numId !== "0") {
              const para = stack[stack.length - 1];
              if (para) para.num = { id: numId, level: numLevel };
            }
            numId = null;
            numLevel = 0;
            break;
          case "w:rPr":
            inRunProps = false;
            break;
          case "w:r":
            run = null;
            break;
          case "w:t":
            textOpen = false;
            break;
          case "w:delText":
          case "w:del":
            deleted -= 1;
            break;
          case "w:instrText":
            instr -= 1;
            break;
          case "w:footnote":
            noteId = null;
            break;
          case "w:p": {
            const para = stack.pop();
            if (!para) break;
            const text = para.runs.map((item) => item.text).join("").trim();
            if (text.length === 0) break;
            let block: Block;
            const heading = para.style?.title ? 1 : para.style?.heading;
            if (para.num && ordered.has(para.num.id)) {
              block = { kind: "item", ordered: ordered.get(para.num.id)?.get(para.num.level) ?? false, level: para.num.level > 0 ? 2 : 1, runs: para.runs };
            } else if (heading !== undefined) {
              block = { kind: "heading", level: heading as 1 | 2 | 3, runs: para.runs };
            } else if (/^\s*(\*\s*){3}$|^\s*#\s*$/u.test(text)) {
              block = { kind: "break" };
            } else {
              block = para.align ? { kind: "paragraph", runs: para.runs, align: para.align } : { kind: "paragraph", runs: para.runs };
            }
            onParagraph(block, noteId);
            break;
          }
          default:
            break;
        }
      },
      text: (value) => {
        if (!textOpen || run === null || deleted > 0 || instr > 0) return;
        const hidden = run.hidden ?? run.style?.vanish ?? false;
        if (hidden || run.tiny || run.white) {
          // Texte masqué, blanc ou ≤ 1 pt : retiré et compté (rapport « invisible »).
          if (value.trim().length > 0) invisible += 1;
          return;
        }
        stack[stack.length - 1]?.runs.push({ text: value, bold: run.bold ?? run.style?.bold, italic: run.italic ?? run.style?.italic });
      },
    });
  };

  const documentPart = read(mainPath);
  if (documentPart === undefined) fail("main_part");
  // Espace de noms strict (ISO 29500 strict) : non pris en charge (C4).
  const head = new TextDecoder().decode(documentPart.subarray(0, 2048));
  if (head.includes(STRICT_NS)) fail("strict");

  const blocks: Block[] = [];
  paragraphs(documentPart, (block) => blocks.push(block));

  if (footnotesPart && footnoteOrder.length > 0) {
    const notes = read(footnotesPart);
    if (notes) {
      paragraphs(notes, (block, id) => {
        if (id === null || block.kind === "break") return;
        const runs = "runs" in block ? block.runs : [];
        footnoteTexts.set(id, [...(footnoteTexts.get(id) ?? []), ...(footnoteTexts.has(id) ? [{ text: " " }] : []), ...runs]);
      });
    }
    // Notes reportées en fin de texte (AC-077).
    blocks.push({ kind: "heading", level: 2, runs: [{ text: "Notes" }] });
    footnoteOrder.forEach((id, index) => {
      blocks.push({ kind: "paragraph", runs: [{ text: `[${String(index + 1)}] ` }, ...(footnoteTexts.get(id) ?? [])] });
    });
  }

  const simplified = externalLinks > 0 || names.some((name) => name.startsWith("word/media/")) || invisible > 0;
  return {
    title: fileName.replace(/\.(docx|docm|dotx)$/iu, "").trim() || "Sans titre",
    suggestedMode: suggestMode(blocks, true),
    blocks,
    report: { simplified, invisible, externalLinks, footnotes: footnoteOrder.length },
  };
}
