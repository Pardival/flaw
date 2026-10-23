import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild-wasm";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

await esbuild.initialize({ worker: false });

const alias = {
  "prosemirror-model": require.resolve("prosemirror-model"),
  parse5: require.resolve("parse5"),
};

const shared = {
  bundle: true,
  format: "esm",
  alias,
  legalComments: "none",
  logLevel: "warning",
};

await esbuild.build({
  ...shared,
  entryPoints: [join(root, "src/index.ts")],
  platform: "neutral",
  outfile: join(root, "dist/pagination.js"),
});

await esbuild.build({
  ...shared,
  entryPoints: [join(root, "src/browser.ts")],
  platform: "browser",
  outfile: join(root, "dist/browser.js"),
});
