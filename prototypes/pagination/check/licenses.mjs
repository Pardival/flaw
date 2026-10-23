import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { collectEntries, isAllowedLicense, isWorkspacePackage } from "../../../scripts/check-licenses.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const stdout = execFileSync("pnpm", ["licenses", "list", "--json", "--long"], {
  cwd: root,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
const start = stdout.search(/[[{]/);
if (start < 0) throw new Error("Aucun JSON de licences pour le prototype.");
const entries = collectEntries(JSON.parse(stdout.slice(start))).filter((entry) => {
  if (isWorkspacePackage(entry)) return false;
  // Même règle que la racine : la licence du projet Flaw n'est pas décidée.
  return entry.name !== "@flaw/schema";
});
if (entries.length === 0) throw new Error("Aucune dépendance du prototype à vérifier.");
const rejected = entries.filter((entry) => !isAllowedLicense(entry.license));
if (rejected.length > 0) {
  for (const entry of rejected) {
    process.stderr.write(`${entry.name}: ${entry.license || "(absente)"}\n`);
  }
  throw new Error("Dépendance du prototype hors liste A-002.");
}
process.stdout.write(`A-002 prototype : ${entries.length} dépendances autorisées.\n`);
