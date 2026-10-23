import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { discoverHarnessFiles, evaluateDbTests, loadManifest } from "./check-db-tests.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const passwordMarker = "POSTGRES_" + "PASSWORD";
const migrationCall = "apply" + "Migrations(";

const manifest = {
  comment: "Abaisser un seuil exige une revue de sécurité.",
  files: {
    "auth.test.ts": 20,
    "rls.test.ts": 12,
  },
};

function logOf(lines) {
  return lines.join("\n");
}

describe("seuil DB par fichier", () => {
  it("échoue si un fichier du manifeste n'imprime rien", () => {
    const result = evaluateDbTests({
      manifest,
      log: logOf(["DB_TESTS_EXECUTED[rls.test.ts]=12"]),
      harnessFiles: ["auth.test.ts", "rls.test.ts"],
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("DB_TESTS_EXECUTED[auth.test.ts] absent");
  });

  it("échoue si un fichier est sous son seuil", () => {
    const result = evaluateDbTests({
      manifest,
      log: logOf(["DB_TESTS_EXECUTED[auth.test.ts]=19", "DB_TESTS_EXECUTED[rls.test.ts]=12"]),
      harnessFiles: ["auth.test.ts", "rls.test.ts"],
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("DB_TESTS_EXECUTED[auth.test.ts]=19 sous le seuil 20");
  });

  it("échoue si un fichier du harnais Postgres n'est pas dans le manifeste", () => {
    const result = evaluateDbTests({
      manifest,
      log: logOf(["DB_TESTS_EXECUTED[auth.test.ts]=20", "DB_TESTS_EXECUTED[rls.test.ts]=12"]),
      harnessFiles: ["auth.test.ts", "rls.test.ts", "nouveau.test.ts"],
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("nouveau.test.ts utilise le harnais Postgres et n'est pas dans le manifeste");
  });

  it("accepte chaque fichier à son seuil et ignore une valeur globale", () => {
    const result = evaluateDbTests({
      manifest,
      log: logOf([
        "DB_TESTS_EXECUTED[auth.test.ts]=20",
        "DB_TESTS_EXECUTED=99",
        "DB_TESTS_EXECUTED[rls.test.ts]=12",
      ]),
      harnessFiles: ["rls.test.ts", "auth.test.ts"],
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.lines).toEqual([
      "DB_TESTS_EXECUTED[auth.test.ts]=20 seuil=20",
      "DB_TESTS_EXECUTED[rls.test.ts]=12 seuil=12",
    ]);
  });

  it("repère le harnais Postgres et laisse de côté l'image seule", () => {
    const dir = mkdtempSync(join(tmpdir(), "flaw-db-tests-"));
    try {
      mkdirSync(join(dir, "db"));
      writeFileSync(
        join(dir, "db", "suite.test.ts"),
        `const env = "${passwordMarker}";\n${migrationCall}\n`,
      );
      const imageOnly = "postgres:" + "18.6-alpine";
      writeFileSync(join(dir, "db", "awk.test.ts"), `const image = "${imageOnly}";\n`);
      const runArg = '["' + "run" + '"';
      writeFileSync(
        join(dir, "db", "lance.test.ts"),
        `spawnSync("docker", ${runArg}, "--name", "db", "${imageOnly}"]);\n`,
      );
      const discovered = discoverHarnessFiles(dir);
      expect(discovered.duplicates).toEqual([]);
      expect(discovered.files).toEqual(["lance.test.ts", "suite.test.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("le manifeste du dépôt couvre les fichiers du harnais et interdit d'abaisser un seuil sans revue", () => {
    const committed = loadManifest(join(repo, "ci/db-tests.json"));
    expect(committed.comment).toContain("revue de sécurité");
    expect(committed.comment).toContain("Lowering a threshold requires security review");
    const discovered = discoverHarnessFiles(repo);
    expect(discovered.duplicates).toEqual([]);
    expect(discovered.files).toEqual(Object.keys(committed.files).sort());
    expect(committed.files["auth.test.ts"]).toBeGreaterThanOrEqual(30);
    expect(committed.files["rls.test.ts"]).toBeGreaterThanOrEqual(12);
    expect(committed.files["admin-cli.test.ts"]).toBeGreaterThanOrEqual(14);
  });
});
