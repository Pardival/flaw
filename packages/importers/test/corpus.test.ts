/**
 * Corpus de fichiers malveillants (T-041, SEC-IMP-11) : chaque cas est fabriqué en mémoire
 * et asserte son code d'erreur ou son contenu attendu. Aucun accès réseau n'est toléré,
 * même différé. Les contre-tests prouvent que le vérificateur détecte chaque écart.
 */
import { strToU8, zipSync, type Zippable } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { importFile, toDocument, type ImportReport, type ImportResult } from "../src/index.ts";

// --- Pièges réseau ---------------------------------------------------------------
const network: string[] = [];
const saved: Record<string, unknown> = {};
const TRAPPED = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource"] as const;

beforeAll(() => {
  const scope = globalThis as Record<string, unknown>;
  for (const name of TRAPPED) {
    saved[name] = scope[name];
  }
  scope.fetch = (...args: unknown[]) => {
    network.push(`fetch ${String(args[0])}`);
    return Promise.reject(new Error("réseau interdit"));
  };
  for (const name of ["XMLHttpRequest", "WebSocket", "EventSource"] as const) {
    scope[name] = class {
      constructor(url?: unknown) {
        network.push(`${name} ${String(url)}`);
        throw new Error("réseau interdit");
      }
    };
  }
});

afterAll(() => {
  const scope = globalThis as Record<string, unknown>;
  for (const name of TRAPPED) {
    scope[name] = saved[name];
  }
});

// --- Fabrique de fichiers ----------------------------------------------------------
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const MAIN = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";

function contentTypes(main = MAIN): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${main}"/></Types>`;
}

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

function body(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${inner}</w:body></w:document>`;
}

const para = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

function docx(parts: Record<string, string | Uint8Array> = {}, level: 0 | 6 = 6): Uint8Array {
  const files: Zippable = {
    "[Content_Types].xml": strToU8(contentTypes()),
    "_rels/.rels": strToU8(RELS),
    "word/document.xml": strToU8(body(para("Bonjour"))),
  };
  for (const [name, value] of Object.entries(parts)) {
    files[name] = typeof value === "string" ? strToU8(value) : value;
  }
  return zipSync(files, { level });
}

/** Retire une partie de l'archive (cas « partie principale absente »). */
function docxWithout(name: string): Uint8Array {
  const files: Zippable = { "[Content_Types].xml": strToU8(contentTypes()), "_rels/.rels": strToU8(RELS) };
  if (name !== "word/document.xml") files["word/document.xml"] = strToU8(body(para("x")));
  return zipSync(files);
}

/** Positions des en-têtes centraux (signature PK\x01\x02) et leurs noms. */
function centralHeaders(bytes: Uint8Array): { at: number; name: string }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const found: { at: number; name: string }[] = [];
  for (let at = 0; at + 46 <= bytes.length; at += 1) {
    if (view.getUint32(at, true) === 0x02014b50) {
      const length = view.getUint16(at + 28, true);
      found.push({ at, name: new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + length)) });
    }
  }
  return found;
}

function tamper(bytes: Uint8Array, edit: (view: DataView, central: { at: number; name: string }[]) => void): Uint8Array {
  const copy = bytes.slice();
  edit(new DataView(copy.buffer), centralHeaders(copy));
  return copy;
}

const nested = (depth: number) => `${"<w:p>".repeat(depth)}${"</w:p>".repeat(depth)}`;

// --- Corpus ------------------------------------------------------------------------
type Expect = {
  code?: string;
  contains?: string[];
  absent?: string[];
  report?: Partial<ImportReport>;
};

type Case = { name: string; file: string; bytes: () => Uint8Array } & Expect;

const enc = (text: string) => new TextEncoder().encode(text);
const RLO = "‮";

const CASES: Case[] = [
  // Archive et conteneur
  { name: "docx valide", file: "ok.docx", bytes: () => docx(), contains: ["Bonjour"] },
  { name: "pas une archive sous .docx", file: "faux.docx", bytes: () => enc("je ne suis pas un zip"), code: "not_zip" },
  { name: "Word 97 (OLE) déguisé", file: "vieux.docx", bytes: () => new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]), code: "ole" },
  { name: "exécutable déguisé", file: "virus.docx", bytes: () => new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0]), code: "unsupported" },
  { name: "PDF déguisé en .md", file: "doc.md", bytes: () => enc("%PDF-1.7\n"), code: "unsupported" },
  { name: "archive ZIP générique", file: "export-notion.zip", bytes: () => zipSync({ "page.md": strToU8("# Titre") }), code: "zip_archive" },
  { name: "fichier trop gros", file: "gros.docx", bytes: () => { const b = new Uint8Array(21 * 1024 * 1024); b.set([0x50, 0x4b, 0x03, 0x04]); return b; }, code: "too_large" },
  { name: "bombe de décompression", file: "bombe.docx", bytes: () => docx({ "word/document.xml": body(para(" ".repeat(6 * 1024 * 1024))) }), code: "bomb" },
  { name: "trop d'entrées", file: "entrees.docx", bytes: () => docx(Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`word/media/f${String(i)}.bin`, "x"]))), code: "entries" },
  { name: "chemin remontant (../)", file: "chemin.docx", bytes: () => docx({ "../../evil.xml": "x" }), code: "path" },
  { name: "chemin absolu", file: "absolu.docx", bytes: () => docx({ "/etc/passwd": "x" }), code: "path" },
  { name: "séparateur Windows", file: "windows.docx", bytes: () => docx({ "word\\evil.xml": "x" }), code: "path" },
  { name: "nom en double (casse)", file: "double.docx", bytes: () => docx({ "WORD/document.xml": body(para("autre")) }), code: "dup" },
  {
    name: "archive chiffrée",
    file: "chiffre.docx",
    bytes: () => tamper(docx(), (view, central) => {
      for (const header of central) view.setUint16(header.at + 8, view.getUint16(header.at + 8, true) | 1, true);
    }),
    code: "zip",
  },
  {
    name: "taille annoncée fausse",
    file: "taille.docx",
    bytes: () => tamper(docx({}, 0), (view, central) => {
      for (const header of central) view.setUint32(header.at + 24, view.getUint32(header.at + 24, true) + 7, true);
    }),
    code: "zip_size",
  },
  // Macros et modèles
  { name: "projet VBA", file: "macro.docx", bytes: () => docx({ "word/vbaProject.bin": "VBA" }), code: "macro" },
  { name: "extension .docm", file: "macro.docm", bytes: () => docx(), code: "macro" },
  { name: "type principal à macros", file: "type.docx", bytes: () => docx({ "[Content_Types].xml": contentTypes("application/vnd.ms-word.document.macroEnabled.main+xml") }), code: "macro" },
  { name: "modèle .dotx", file: "modele.dotx", bytes: () => docx(), code: "template" },
  // XML
  { name: "DTD (XXE)", file: "xxe.docx", bytes: () => docx({ "word/document.xml": `<?xml version="1.0"?><!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]>${body(para("&x;")).replace(/^<\?xml[^>]*>/u, "")}` }), code: "dtd" },
  { name: "milliard de rires", file: "rires.docx", bytes: () => docx({ "word/document.xml": `<?xml version="1.0"?><!DOCTYPE l [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]><w:document xmlns:w="${W}"><w:body>${para("&b;")}</w:body></w:document>` }), code: "dtd" },
  { name: "entité externe dans les types", file: "types.docx", bytes: () => docx({ "[Content_Types].xml": `<?xml version="1.0"?><!DOCTYPE t [<!ENTITY e SYSTEM "http://evil.example/x">]>${contentTypes().replace(/^<\?xml[^>]*>/u, "")}` }), code: "dtd" },
  { name: "XML mal formé", file: "casse.docx", bytes: () => docx({ "word/document.xml": `<w:document xmlns:w="${W}"><w:body><w:p>` }), code: "xml" },
  { name: "encodage UTF-16 déclaré", file: "utf16.docx", bytes: () => docx({ "word/document.xml": body(para("x")).replace('encoding="UTF-8"', 'encoding="UTF-16"') }), code: "xml_encoding" },
  { name: "imbrication profonde", file: "profond.docx", bytes: () => docx({ "word/document.xml": body(nested(300)) }), code: "depth" },
  { name: "trop d'attributs", file: "attributs.docx", bytes: () => docx({ "word/document.xml": body(`<w:p ${Array.from({ length: 70 }, (_, i) => `a${String(i)}="1"`).join(" ")}/>`) }), code: "attrs" },
  { name: "OOXML strict", file: "strict.docx", bytes: () => docx({ "word/document.xml": body(para("x")).replace(W, "http://purl.oclc.org/ooxml/wordprocessingml/main") }), code: "strict" },
  { name: "partie principale absente", file: "vide.docx", bytes: () => docxWithout("word/document.xml"), code: "main_part" },
  // Contenu piégé dans un .docx valide
  {
    name: "texte masqué",
    file: "masque.docx",
    bytes: () => docx({ "word/document.xml": body(`${para("Visible")}<w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>SECRET-CACHE</w:t></w:r></w:p>`) }),
    contains: ["Visible"],
    absent: ["SECRET-CACHE"],
    report: { invisible: 1 },
  },
  { name: "inversion bidi (docx)", file: "bidi.docx", bytes: () => docx({ "word/document.xml": body(para(`facture${RLO}fdp.exe`)) }), contains: ["facturefdp.exe"], absent: [RLO] },
  {
    name: "lien externe",
    file: "lien.docx",
    bytes: () => docx({
      "word/_rels/document.xml.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="http://evil.example/piege" TargetMode="External"/></Relationships>`,
      "word/document.xml": body(`<w:p><w:hyperlink r:id="rId9"><w:r><w:t>clique ici</w:t></w:r></w:hyperlink></w:p>`),
    }),
    contains: ["clique ici"],
    absent: ["evil.example"],
  },
  { name: "balise script en texte", file: "script.docx", bytes: () => docx({ "word/document.xml": body(para("&lt;script&gt;alert(1)&lt;/script&gt;")) }), contains: ["<script>alert(1)</script>"] },
  // Markdown et texte
  { name: "markdown valide", file: "ok.md", bytes: () => enc("# Titre\n\nUn **gras** et un *italique*."), contains: ["Titre", "gras", "italique"] },
  // HTML désactivé : il reste du texte littéral, jamais un élément (affiché, pas interprété).
  { name: "HTML brut dans le markdown", file: "html.md", bytes: () => enc("<img src=x onerror=alert(1)>"), contains: ["<img src=x onerror=alert(1)>"], absent: ['"type":"image"', '"type":"html'] },
  // Lien javascript: refusé par markdown-it : texte littéral, aucun lien.
  { name: "lien javascript:", file: "js.md", bytes: () => enc("[clique](javascript:alert(1))"), contains: ["[clique](javascript:alert(1))"], absent: ['"type":"link"'] },
  { name: "image distante", file: "image.md", bytes: () => enc("![traceur](http://evil.example/pixel.png)"), absent: ["evil.example"] },
  { name: "listes trop imbriquées", file: "listes.md", bytes: () => enc(Array.from({ length: 30 }, (_, i) => `${"  ".repeat(i)}- niveau ${String(i)}`).join("\n")), code: "nesting" },
  { name: "octets nuls", file: "nul.txt", bytes: () => enc("abc\u0000def"), code: "null_bytes" },
  { name: "inversion bidi (markdown)", file: "bidi.md", bytes: () => enc(`Paie${RLO}ment`), contains: ["Paiement"], absent: [RLO] },
  { name: "texte trop gros", file: "gros.txt", bytes: () => new Uint8Array(11 * 1024 * 1024).fill(0x61), code: "too_large" },
  { name: "extension inconnue", file: "outil.exe", bytes: () => enc("rien"), code: "unsupported" },
];

// --- Vérificateur ------------------------------------------------------------------
type Outcome = { code?: string; result?: ImportResult; network: string[] };

function run(c: Case): Outcome {
  const before = network.length;
  try {
    const result = importFile(c.bytes(), c.file);
    return { result, network: network.slice(before) };
  } catch (error) {
    const code = (error as { code?: string }).code ?? `exception ${String(error)}`;
    return { code, network: network.slice(before) };
  }
}

/** Ce qui entre réellement dans l'éditeur : le document produit, plus le titre proposé. */
function textOf(result: ImportResult): string {
  return JSON.stringify(toDocument(result.blocks, result.suggestedMode)) + result.title;
}

/** Écarts entre un résultat et ses attentes (vide = conforme). */
function check(c: Expect, outcome: Outcome): string[] {
  const gaps: string[] = [];
  if (outcome.network.length > 0) gaps.push(`réseau : ${outcome.network.join(", ")}`);
  if (c.code !== undefined) {
    if (outcome.code !== c.code) gaps.push(`code : attendu ${c.code}, obtenu ${outcome.code ?? "succès"}`);
    return gaps;
  }
  if (outcome.result === undefined) {
    gaps.push(`code : succès attendu, obtenu ${outcome.code ?? "?"}`);
    return gaps;
  }
  const text = textOf(outcome.result);
  for (const piece of c.contains ?? []) if (!text.includes(JSON.stringify(piece).slice(1, -1))) gaps.push(`contenu absent : ${piece}`);
  for (const piece of c.absent ?? []) if (text.includes(piece) || text.includes(JSON.stringify(piece).slice(1, -1))) gaps.push(`contenu interdit : ${piece}`);
  for (const [key, value] of Object.entries(c.report ?? {})) {
    if (outcome.result.report[key as keyof ImportReport] !== value) gaps.push(`rapport ${key} : attendu ${String(value)}`);
  }
  return gaps;
}

describe("corpus de fichiers malveillants (T-041)", () => {
  for (const c of CASES) {
    it(c.name, () => {
      expect(check(c, run(c))).toEqual([]);
    }, 30_000);
  }

  it("aucun appel réseau, même différé, après le corpus", async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
    expect(network).toEqual([]);
  });
});

describe("contre-tests : le vérificateur détecte chaque écart", () => {
  const valid = CASES.find((c) => c.name === "docx valide");
  const bidi = CASES.find((c) => c.name === "inversion bidi (docx)");
  if (valid === undefined || bidi === undefined) throw new Error("cas de référence absents");

  it("code", () => {
    expect(check({ code: "macro" }, run(valid)).length).toBeGreaterThan(0);
  });
  it("contenu", () => {
    expect(check({ contains: ["texte qui n'existe pas"] }, run(valid)).length).toBeGreaterThan(0);
  });
  it("bidi", () => {
    // Si le caractère d'inversion survivait, l'attente « absent » le signalerait.
    const outcome = run(bidi);
    const leaked = { ...outcome, result: outcome.result && { ...outcome.result, title: RLO } };
    expect(check({ absent: [RLO] }, leaked).length).toBeGreaterThan(0);
  });
  it("réseau", () => {
    expect(check({}, { ...run(valid), network: ["fetch http://evil.example"] }).length).toBeGreaterThan(0);
  });
});
