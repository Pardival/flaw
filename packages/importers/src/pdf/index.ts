// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- déclaration ambiante, vue aussi depuis apps/web
/// <reference path="./pdfjs-worker.d.ts" />
import { suggestMode, type ImportResult } from "../blocks.ts";
import { fail } from "../errors.ts";
import { LIMITS } from "../limits.ts";
import { pagesToBlocks, type PdfItem, type PdfPage } from "./layout.ts";

type TextItem = { str: string; transform: number[]; width: number; height: number };

/**
 * Import PDF (A-017) avec pdf.js, sans worker supplémentaire : on est déjà dans
 * le worker d'import, sans réseau. Ni polices, ni WebAssembly, ni scripts, ni XFA :
 * seul le texte est lu. Un PDF scanné (images seules) n'a pas de texte à lire.
 */
export async function importPdf(bytes: Uint8Array, fileName: string): Promise<ImportResult> {
  if (bytes.length > LIMITS.pdfFileBytes) fail("too_large");
  // Moteur pdf.js dans ce même fil : `globalThis.pdfjsWorker` évite tout second worker.
  // Chargé dans un worker, il se brancherait de lui-même sur ses messages : on lui
  // masque `postMessage` le temps de l'import pour qu'il reste une simple bibliothèque.
  const scope = globalThis as { postMessage?: unknown; pdfjsWorker?: unknown };
  const own = Object.getOwnPropertyDescriptor(scope, "postMessage");
  Object.defineProperty(scope, "postMessage", { value: undefined, configurable: true, writable: true });
  let worker;
  try {
    worker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  } finally {
    delete scope.postMessage;
    if (own !== undefined) {
      Object.defineProperty(scope, "postMessage", own);
    }
  }
  scope.pdfjsWorker = worker;
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const task = pdfjs.getDocument({
    data: bytes.slice(),
    isImageDecoderSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
    useWasm: false,
    stopAtErrors: false,
    verbosity: 0,
  });
  let document;
  try {
    document = await task.promise;
  } catch (error) {
    await task.destroy();
    if (error instanceof Error && error.name === "PasswordException") fail("pdf_encrypted");
    return fail("pdf_invalid");
  }

  try {
    if (document.numPages > LIMITS.pdfPages) fail("too_large");
    const pages: PdfPage[] = [];
    let total = 0;
    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items: PdfItem[] = [];
      for (const raw of content.items) {
        if (!("str" in raw)) {
          continue;
        }
        const item = raw as TextItem;
        total += item.str.length;
        items.push({
          text: item.str,
          x: item.transform[4] ?? 0,
          y: item.transform[5] ?? 0,
          width: item.width,
          height: item.height || Math.hypot(item.transform[2] ?? 0, item.transform[3] ?? 0),
        });
      }
      if (total > LIMITS.outputBytes) fail("output_too_large");
      pages.push({ width: viewport.width, height: viewport.height, items });
      page.cleanup();
    }
    const blocks = pagesToBlocks(pages);
    if (blocks.length === 0) fail("pdf_no_text");
    const info = (await document.getMetadata().catch(() => null))?.info as { Title?: unknown } | undefined;
    const metaTitle = typeof info?.Title === "string" ? info.Title.trim() : "";
    return {
      title: metaTitle.slice(0, 200) || fileName.replace(/\.pdf$/iu, "").trim() || "Sans titre",
      suggestedMode: suggestMode(blocks, true),
      blocks,
      report: { simplified: true, invisible: 0, externalLinks: 0, footnotes: 0, pdf: true },
    };
  } finally {
    await task.destroy();
  }
}
