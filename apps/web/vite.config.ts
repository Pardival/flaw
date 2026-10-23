import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  esbuild: {
    jsx: "automatic",
  },
  server: {
    fs: {
      allow: [repoRoot],
    },
  },
});
