import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkProject } from "./check-licenses.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const script = fileURLToPath(new URL("./check-licenses.mjs", import.meta.url));

const PG_TREE = [
  "pg",
  "pg-pool",
  "pg-protocol",
  "pg-types",
  "pg-connection-string",
  "postgres-array",
  "postgres-interval",
];

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

describe("AC-092", () => {
  it("voit pg et les dépendances de tous les sous-projets du monorepo", () => {
    const { entries, rejected } = checkProject(repo);
    const names = new Set(entries.map((entry) => entry.name));
    for (const name of PG_TREE) {
      expect(names.has(name), name).toBe(true);
    }
    expect(rejected).toEqual([]);
  });

  it("rejette un paquet GPL déclaré dans apps/server et voit l'autre sous-projet", () => {
    const fixture = mkdtempSync(join(tmpdir(), "flaw-licenses-"));
    try {
      mkdirSync(join(fixture, "apps/server"), { recursive: true });
      mkdirSync(join(fixture, "apps/web"), { recursive: true });
      mkdirSync(join(fixture, "vendor/gpl-pkg"), { recursive: true });
      mkdirSync(join(fixture, "vendor/mit-pkg"), { recursive: true });
      writeJson(join(fixture, "package.json"), {
        name: "lic-fixture",
        private: true,
        packageManager: "pnpm@12.11.2",
      });
      writeFileSync(
        join(fixture, "pnpm-workspace.yaml"),
        'packages:\n  - "apps/*"\n',
      );
      writeJson(join(fixture, "apps/server/package.json"), {
        name: "@flaw/server",
        private: true,
        dependencies: { "gpl-pkg": "file:../../vendor/gpl-pkg" },
      });
      writeJson(join(fixture, "apps/web/package.json"), {
        name: "@flaw/web",
        private: true,
        dependencies: { "mit-pkg": "file:../../vendor/mit-pkg" },
      });
      writeJson(join(fixture, "vendor/gpl-pkg/package.json"), {
        name: "gpl-pkg",
        version: "1.0.0",
        license: "GPL-3.0-only",
      });
      writeJson(join(fixture, "vendor/mit-pkg/package.json"), {
        name: "mit-pkg",
        version: "1.0.0",
        license: "MIT",
      });
      execFileSync("pnpm", ["install"], { cwd: fixture, stdio: "inherit" });

      const { entries, rejected } = checkProject(fixture);
      const names = entries.map((entry) => entry.name);
      expect(names).toContain("gpl-pkg");
      expect(names).toContain("mit-pkg");
      expect(rejected.map((entry) => entry.name)).toEqual(["gpl-pkg"]);
      expect(rejected[0]?.license).toBe("GPL-3.0-only");

      let status = 0;
      let output = "";
      try {
        output = execFileSync(process.execPath, [script, fixture], {
          encoding: "utf8",
        });
      } catch (error) {
        status = typeof error.status === "number" ? error.status : 1;
        output = `${error.stdout?.toString() ?? ""}\n${error.stderr?.toString() ?? ""}`;
      }
      expect(status).not.toBe(0);
      expect(output).toContain("gpl-pkg");
      expect(output).toContain("GPL-3.0-only");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
