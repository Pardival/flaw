import { SaxesParser, type SaxesTagPlain } from "saxes";

import { fail } from "./errors.ts";
import { LIMITS } from "./limits.ts";

/**
 * XML sûr : aucune DTD ni entité (préfiltre hors CDATA, commentaires et PI),
 * UTF-8 seulement, profondeur et attributs bornés. Pas de DOM, pas de ressource externe.
 */
export function decodeXml(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("xml_encoding");
  }
  const declaration = /^\uFEFF?<\?xml[^?]*encoding\s*=\s*["']([^"']+)["']/u.exec(text);
  if (declaration && declaration[1]?.toLowerCase() !== "utf-8") {
    fail("xml_encoding");
  }
  // Préfiltre : DOCTYPE/ENTITY hors CDATA, commentaires et instructions de traitement.
  const stripped = text.replace(/<!\[CDATA\[[\s\S]*?\]\]>/gu, "").replace(/<!--[\s\S]*?-->/gu, "").replace(/<\?[\s\S]*?\?>/gu, "");
  if (/<!DOCTYPE|<!ENTITY/iu.test(stripped)) {
    fail("dtd");
  }
  return text;
}

export type SaxHandlers = {
  open: (tag: SaxesTagPlain, depth: number) => void;
  close: (name: string, depth: number) => void;
  text: (text: string) => void;
};

export function parseXml(bytes: Uint8Array, handlers: SaxHandlers): void {
  const source = decodeXml(bytes);
  const parser = new SaxesParser({ xmlns: false, position: false });
  let depth = 0;
  parser.on("doctype", () => fail("dtd"));
  parser.on("error", () => fail("xml"));
  parser.on("opentag", (tag) => {
    depth += 1;
    if (depth > LIMITS.xmlDepth) fail("depth");
    if (Object.keys(tag.attributes).length > LIMITS.xmlAttributes) fail("attrs");
    handlers.open(tag as SaxesTagPlain, depth);
    if (tag.isSelfClosing) {
      handlers.close(tag.name, depth);
      depth -= 1;
    }
  });
  parser.on("closetag", (tag) => {
    if (tag.isSelfClosing) {
      return;
    }
    handlers.close(tag.name, depth);
    depth -= 1;
  });
  parser.on("text", handlers.text);
  parser.on("cdata", handlers.text);
  try {
    parser.write(source).close();
  } catch (error) {
    if (error instanceof Error && error.name === "ImportError") throw error;
    fail("xml");
  }
}

export function attr(tag: SaxesTagPlain, name: string): string | undefined {
  const value = tag.attributes[name];
  return typeof value === "string" ? value : undefined;
}
