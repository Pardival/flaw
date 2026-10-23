import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { describe, expect, it } from "vitest";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const apiMethods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];

function classBody(source: string, name: string): string {
  const start = source.indexOf(`class ${name} `);
  if (start < 0) {
    throw new Error(`classe ${name} absente du service worker`);
  }
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(open, index + 1);
      }
    }
  }
  throw new Error(`classe ${name} inachevée`);
}

/** Même motif que navigateFallbackDenylist dans le service worker de production. */
const apiNavigation = /^\/api\//;

describe("SEC-CLI-03", () => {
  it("le service worker généré ne met aucune réponse /api/* en cache", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "flaw-web-"));
    try {
      await build({
        root: webRoot,
        configFile: join(webRoot, "vite.config.ts"),
        logLevel: "error",
        build: { outDir, emptyOutDir: true },
      });
      const worker = readFileSync(join(outDir, "sw.js"), "utf8");

      const precachePattern = /\{url:"([^"]+)"/g;
      const precache = [...worker.matchAll(precachePattern)].map((match) => match[1] ?? "");
      expect(precache).toContain("index.html");
      for (const url of precache) {
        expect(url.includes("/api/"), url).toBe(false);
      }

      expect(worker).toContain("denylist:[/^\\/api\\//]");
      expect(apiNavigation.test("/api/v1/documents")).toBe(true);
      expect(apiNavigation.test("/api/v1/me?suite=1")).toBe(true);
      expect(apiNavigation.test("/")).toBe(false);
      expect(apiNavigation.test("/bibliotheque")).toBe(false);

      const routes = [
        ...worker.matchAll(/\/\\\/api\\\/\/,new ([A-Za-z_$][\w$]*),"([A-Z]+)"/g),
      ];
      expect(routes.map((match) => match[2]).sort()).toEqual([...apiMethods].sort());
      const strategyNames = new Set(routes.map((match) => match[1]));
      expect(strategyNames.size).toBe(1);
      const strategyName = [...strategyNames][0];
      if (strategyName === undefined) {
        throw new Error("stratégie /api absente");
      }
      const strategy = classBody(worker, strategyName);
      expect(strategy).toContain(".fetch(");
      expect(strategy).not.toContain("cachePut");
      expect(strategy).not.toContain("fetchAndCachePut");
      expect(strategy).not.toContain("caches");
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
