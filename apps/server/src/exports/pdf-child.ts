/**
 * Processus enfant du repli PDF (A-016, T-035) : lit {data} sur stdin, écrit le PDF
 * sur stdout. Lancé avec une mémoire bornée ; tué au-delà de 60 s par le parent.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { NodeCompiler } from "@myriaddreamin/typst-ts-node-compiler";

import { TYPST_MAIN } from "../../../../packages/exporters/src/pdf/template.ts";

const fonts = fileURLToPath(new URL("../../../../assets/fonts/pdf/", import.meta.url));

function main(): void {
  const raw = readFileSync(0);
  // Racine Typst vide et dédiée : le gabarit ne lit que /data.json, ombré en mémoire.
  const workspace = mkdtempSync(join(tmpdir(), "flaw-typst-"));
  const compiler = NodeCompiler.create({ workspace, fontArgs: [{ fontPaths: [fonts] }] });
  compiler.mapShadow(join(workspace, "data.json"), raw);
  const pdf = compiler.pdf({ mainFileContent: TYPST_MAIN });
  process.stdout.write(pdf);
}

try {
  main();
} catch {
  process.exitCode = 1;
}
