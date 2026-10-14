/**
 * AC-092 / SEC-SUPPLY-05 — échoue si une dépendance a une licence hors liste A-002.
 * `pnpm -r licenses list` parcourt tous les sous-projets du workspace.
 * Les paquets du workspace Flaw sont exclus : la licence du projet n'est pas décidée.
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const ALLOWED = new Set([
  "MIT",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BSD-4-Clause",
  "0BSD",
  "Apache-2.0",
  "PostgreSQL",
  "OFL-1.1",
]);

const root = fileURLToPath(new URL("..", import.meta.url));

function stripOuterParens(value) {
  let current = value.trim();
  while (current.startsWith("(") && current.endsWith(")")) {
    let depth = 0;
    let wrapsAll = true;
    for (let index = 0; index < current.length; index += 1) {
      const character = current[index];
      if (character === "(") {
        depth += 1;
      } else if (character === ")") {
        depth -= 1;
      }
      if (depth === 0 && index < current.length - 1) {
        wrapsAll = false;
        break;
      }
    }
    if (!wrapsAll || depth !== 0) {
      break;
    }
    current = current.slice(1, -1).trim();
  }
  return current;
}

function splitTopLevel(expression, operator) {
  const parts = [];
  let depth = 0;
  let current = "";
  const tokens = expression.split(/\s+/);
  for (const token of tokens) {
    if (token.length === 0) {
      continue;
    }
    depth += (token.match(/\(/g) ?? []).length;
    depth -= (token.match(/\)/g) ?? []).length;
    if (depth === 0 && token === operator) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current = current.length === 0 ? token : `${current} ${token}`;
  }
  if (current.trim().length > 0) {
    parts.push(current.trim());
  }
  return parts;
}

export function isAllowedLicense(expression) {
  if (typeof expression !== "string" || expression.trim().length === 0) {
    return false;
  }
  if (expression.includes(" WITH ")) {
    return false;
  }
  const alternatives = splitTopLevel(stripOuterParens(expression), "OR");
  return alternatives.some((alternative) => {
    const requirements = splitTopLevel(stripOuterParens(alternative), "AND");
    return (
      requirements.length > 0 &&
      requirements.every((requirement) => ALLOWED.has(stripOuterParens(requirement)))
    );
  });
}

function assertLicenseParser() {
  const cases = [
    ["MIT", true],
    ["ISC", true],
    ["Apache-2.0", true],
    ["BSD-3-Clause", true],
    ["0BSD", true],
    ["PostgreSQL", true],
    ["OFL-1.1", true],
    ["(MIT OR Apache-2.0)", true],
    ["(MIT) OR (Apache-2.0)", true],
    ["MIT OR GPL-3.0-only", true],
    ["MIT AND Apache-2.0", true],
    ["GPL-3.0-only", false],
    ["MIT AND GPL-3.0-only", false],
    ["GPL-3.0-only OR AGPL-3.0-only", false],
    ["Apache-2.0 WITH LLVM-exception", false],
    ["", false],
  ];
  const failed = cases.filter(
    ([expression, expected]) => isAllowedLicense(expression) !== expected,
  );
  if (failed.length > 0) {
    console.error("Contrôle de licences : le parseur SPDX a échoué.");
    for (const [expression, expected] of failed) {
      console.error(`- ${JSON.stringify(expression)} attendu ${expected}`);
    }
    process.exit(1);
  }
}

function licenseText(value) {
  if (typeof value === "string") {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value.map((entry) => licenseText(entry)).join(" OR ");
  }
  if (value && typeof value === "object" && typeof value.type === "string") {
    return value.type.trim();
  }
  return "";
}

export function collectEntries(data) {
  if (Array.isArray(data)) {
    return data;
  }
  if (!data || typeof data !== "object") {
    throw new Error("Sortie `pnpm licenses list --json` illisible.");
  }
  const entries = [];
  for (const [key, value] of Object.entries(data)) {
    if (!Array.isArray(value)) {
      continue;
    }
    for (const item of value) {
      const fromItem = licenseText(item?.license);
      entries.push({
        name: typeof item?.name === "string" ? item.name : "(sans nom)",
        license: fromItem.length > 0 ? fromItem : key,
        paths: Array.isArray(item?.paths) ? item.paths.map(String) : [],
      });
    }
  }
  return entries;
}

export function isWorkspacePackage(entry) {
  if (entry.paths.length === 0) {
    return false;
  }
  return entry.paths.every((packagePath) => !packagePath.includes("node_modules"));
}

export function readLicenseReport(cwd) {
  const stdout = execFileSync("pnpm", ["-r", "licenses", "list", "--json", "--long"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const start = stdout.search(/[[{]/);
  if (start < 0) {
    throw new Error("Aucun JSON dans la sortie de pnpm licenses list.");
  }
  return JSON.parse(stdout.slice(start));
}

export function checkProject(cwd) {
  const entries = collectEntries(readLicenseReport(cwd)).filter(
    (entry) => !isWorkspacePackage(entry),
  );
  const rejected = entries.filter((entry) => !isAllowedLicense(entry.license));
  return { entries, rejected };
}

function report(cwd) {
  assertLicenseParser();
  const { entries, rejected } = checkProject(cwd);
  if (entries.length === 0) {
    console.error("Contrôle de licences : aucune dépendance installée à vérifier.");
    process.exit(1);
  }
  if (rejected.length > 0) {
    console.error("AC-092 : licences hors liste A-002 (MIT, ISC, BSD, Apache-2.0, PostgreSQL, OFL-1.1).");
    for (const entry of rejected) {
      console.error(`- ${entry.name}: ${entry.license || "(absente)"}`);
    }
    process.exit(1);
  }
  const counts = new Map();
  for (const entry of entries) {
    counts.set(entry.license, (counts.get(entry.license) ?? 0) + 1);
  }
  console.log(`AC-092 : ${entries.length} dépendances, licences autorisées.`);
  for (const [license, count] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`- ${license}: ${count}`);
  }
}

function isDirectRun() {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  report(process.argv[2] ?? root);
}
