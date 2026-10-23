/**
 * Q-012 — seuil de tests Postgres par fichier.
 * Le manifeste ci/db-tests.json fixe un minimum par fichier de test.
 * Une somme, ou la dernière valeur imprimée, ne remplace pas ce contrôle.
 * Abaisser un seuil exige une revue de sécurité.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifestPath = join(root, "ci/db-tests.json");
const LINE = /DB_TESTS_EXECUTED\[([^\]\s]+)\]=(\d+)/g;
const TEST_FILE = /\.test\.(?:ts|mts|tsx|js|mjs|cjs)$/;
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage"]);

export function usesPostgresHarness(source) {
  if (source.includes("POSTGRES_PASSWORD") || source.includes("applyMigrations(")) {
    return true;
  }
  // Un `docker run` de l'image postgres:N démarre le serveur. La simple
  // mention de l'image (awk dans le conteneur, entrypoint sleep) ne compte pas.
  return /["']run["'][\s\S]{0,160}postgres:\d/.test(source);
}

export function discoverHarnessFiles(dir) {
  const found = [];
  function walk(current) {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (error) {
      if (error !== null && typeof error === "object" && "code" in error && error.code === "EACCES") {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          continue;
        }
        walk(join(current, entry.name));
        continue;
      }
      if (!entry.isFile() || !TEST_FILE.test(entry.name)) {
        continue;
      }
      const source = readFileSync(join(current, entry.name), "utf8");
      if (usesPostgresHarness(source)) {
        found.push(entry.name);
      }
    }
  }
  walk(dir);
  const counts = new Map();
  for (const name of found) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const duplicates = [...counts.entries()].filter(([, count]) => count > 1).map(([name]) => name);
  return { files: [...counts.keys()].sort(), duplicates };
}

export function loadManifest(path) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("manifeste illisible");
  }
  if (typeof parsed.comment !== "string" || parsed.comment.trim() === "") {
    throw new Error("manifeste sans commentaire de revue");
  }
  if (parsed.files === null || typeof parsed.files !== "object" || Array.isArray(parsed.files)) {
    throw new Error("manifeste sans objet files");
  }
  return parsed;
}

export function evaluateDbTests({ manifest, log, harnessFiles }) {
  const errors = [];
  const thresholds = new Map();
  for (const [name, threshold] of Object.entries(manifest.files)) {
    if (!Number.isInteger(threshold) || threshold < 1) {
      errors.push(`${name}: seuil invalide`);
      continue;
    }
    thresholds.set(name, threshold);
  }

  const seen = new Map();
  for (const match of log.matchAll(LINE)) {
    const name = match[1];
    const count = Number(match[2]);
    const counts = seen.get(name) ?? [];
    counts.push(count);
    seen.set(name, counts);
  }

  const lines = [];
  const names = [...thresholds.keys()].sort();
  for (const name of names) {
    const threshold = thresholds.get(name);
    const counts = seen.get(name);
    if (counts === undefined) {
      errors.push(`DB_TESTS_EXECUTED[${name}] absent`);
      continue;
    }
    const unique = [...new Set(counts)];
    if (unique.length !== 1) {
      errors.push(`DB_TESTS_EXECUTED[${name}] valeurs contradictoires ${counts.join(",")}`);
      continue;
    }
    const count = unique[0];
    lines.push(`DB_TESTS_EXECUTED[${name}]=${count} seuil=${threshold}`);
    if (count < threshold) {
      errors.push(`DB_TESTS_EXECUTED[${name}]=${count} sous le seuil ${threshold}`);
    }
  }

  for (const name of [...harnessFiles].sort()) {
    if (!thresholds.has(name)) {
      errors.push(`${name} utilise le harnais Postgres et n'est pas dans le manifeste`);
    }
  }

  return { ok: errors.length === 0, lines, errors };
}

function isDirectRun() {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  return import.meta.url === pathToFileURL(entry).href;
}

function report(logPath) {
  const manifest = loadManifest(manifestPath);
  const log = readFileSync(logPath, "utf8");
  const discovered = discoverHarnessFiles(root);
  if (discovered.duplicates.length > 0) {
    console.error(`noms de fichiers de tests Postgres en double: ${discovered.duplicates.join(", ")}`);
    process.exit(1);
  }
  const result = evaluateDbTests({
    manifest,
    log,
    harnessFiles: discovered.files,
  });
  for (const line of result.lines) {
    console.log(line);
  }
  if (!result.ok) {
    for (const error of result.errors) {
      console.error(error);
    }
    process.exit(1);
  }
}

if (isDirectRun()) {
  const logPath = process.argv[2];
  if (logPath === undefined) {
    console.error("usage: node scripts/check-db-tests.mjs <journal>");
    process.exit(1);
  }
  report(logPath);
}
