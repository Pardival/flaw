/// <reference lib="webworker" />
import { createTypstCompiler, type TypstCompiler } from "@myriaddreamin/typst.ts/compiler";
import { CompileFormatEnum } from "@myriaddreamin/typst.ts/compiler";
import { disableDefaultFontAssets, loadFonts } from "@myriaddreamin/typst.ts/options.init";
import wasmUrl from "@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm?url";
import { PDF_FONT_FILES, TYPST_MAIN, pdfData, pdfFiles, pdfFonts, safeFileName, type ExportInput, type PdfOptions } from "@flaw/exporters/src/index.ts";

/**
 * PDF sur l'appareil (A-016, T-034) : Typst WASM dans un Web Worker, polices TTF
 * locales seulement (aucune police distante). Le module est chargé au premier PDF,
 * puis gardé en cache par le navigateur.
 */
export type PdfRequest = { input: ExportInput; id: string; options: PdfOptions };
export type PdfResponse = { ok: true; bytes: Uint8Array; name: string } | { ok: false; reason: "fonts" | "compile" };

const fontUrls = import.meta.glob("../../../../assets/fonts/pdf/*.ttf", { query: "?url", import: "default", eager: true }) as Record<string, string>;

function urlsFor(families: string[]): string[] {
  const wanted = new Set(families.flatMap((family) => PDF_FONT_FILES[family] ?? []));
  return Object.entries(fontUrls)
    .filter(([path]) => wanted.has(path.split("/").pop() ?? ""))
    .map(([, url]) => url);
}

let compiler: Promise<TypstCompiler> | null = null;
let loadedFonts = "";

async function getCompiler(families: string[]): Promise<TypstCompiler> {
  const key = families.join("|");
  if (compiler !== null && loadedFonts === key) {
    return compiler;
  }
  loadedFonts = key;
  compiler = (async () => {
    const instance = createTypstCompiler();
    await instance.init({
      getModule: () => wasmUrl,
      beforeBuild: [disableDefaultFontAssets(), loadFonts(urlsFor(families))],
    });
    return instance;
  })();
  return compiler;
}

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = async (event: MessageEvent<PdfRequest>) => {
  const { input, options } = event.data;
  const families = pdfFonts(input);
  if (urlsFor(families).length === 0) {
    scope.postMessage({ ok: false, reason: "fonts" } satisfies PdfResponse);
    return;
  }
  try {
    const typst = await getCompiler(families);
    typst.addSource("/main.typ", TYPST_MAIN);
    typst.mapShadow("/data.json", pdfData(input, options));
    for (const [path, bytes] of Object.entries(pdfFiles(input))) {
      typst.mapShadow(path, bytes);
    }
    const result = await typst.compile({ mainFilePath: "/main.typ", format: CompileFormatEnum.pdf, diagnostics: "none" });
    const bytes = result.result;
    if (!bytes) {
      scope.postMessage({ ok: false, reason: "compile" } satisfies PdfResponse);
      return;
    }
    scope.postMessage({ ok: true, bytes, name: safeFileName(input.title, "pdf") } satisfies PdfResponse, [bytes.buffer]);
  } catch {
    scope.postMessage({ ok: false, reason: "compile" } satisfies PdfResponse);
  }
};
