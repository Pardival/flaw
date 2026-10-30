import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  esbuild: {
    jsx: "automatic",
  },
  // Workers en modules ES (export, PDF Typst) : découpage du WASM et des polices.
  worker: {
    format: "es",
  },
  server: {
    fs: {
      allow: [repoRoot],
    },
    // Développement : l'API Fastify et le WSS de synchro sur la même origine que l'app.
    proxy: {
      "/api": { target: process.env.FLAW_API ?? "http://127.0.0.1:3000", ws: true, changeOrigin: false },
    },
  },
});
