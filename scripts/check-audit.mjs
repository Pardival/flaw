/**
 * SEC-SUPPLY-03 — bloque sur les avis high/critical qui ont un correctif.
 * Les avis sans correctif sont affichés et ne font pas échouer la CI.
 * Exceptions : .github/audit-exceptions.json
 *   { "exceptions": [{ "id": "GHSA-xxxx-xxxx-xxxx", "expires": "AAAA-MM-JJ", "reason": "..." }] }
 * Une exception échue redevient bloquante.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const today = new Date().toISOString().slice(0, 10);
const exceptionsPath = fileURLToPath(new URL("../.github/audit-exceptions.json", import.meta.url));
const exceptions = new Map();

if (existsSync(exceptionsPath)) {
  const parsed = JSON.parse(readFileSync(exceptionsPath, "utf8"));
  const list = Array.isArray(parsed) ? parsed : parsed.exceptions;
  if (!Array.isArray(list)) {
    console.error("SEC-SUPPLY-03 : format d'exceptions illisible.");
    process.exit(1);
  }
  for (const item of list) {
    if (
      item === null ||
      typeof item !== "object" ||
      typeof item.id !== "string" ||
      typeof item.expires !== "string" ||
      typeof item.reason !== "string" ||
      item.reason.trim().length === 0 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(item.expires)
    ) {
      console.error("SEC-SUPPLY-03 : exception incomplète (id, expires AAAA-MM-JJ, reason).");
      process.exit(1);
    }
    exceptions.set(item.id, item);
  }
}

function readAudit() {
  try {
    return execFileSync("pnpm", ["audit", "--json"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    const stdout = error.stdout?.toString() ?? "";
    if (stdout.trim().length === 0) {
      console.error(error.stderr?.toString() ?? String(error));
      process.exit(1);
    }
    return stdout;
  }
}

const stdout = readAudit();

const start = stdout.search(/[{[]/);
if (start < 0) {
  console.error("SEC-SUPPLY-03 : JSON d'audit absent.");
  process.exit(1);
}

const report = JSON.parse(stdout.slice(start));
const advisories = report.advisories ?? {};
const blocking = [];
const unfixed = [];
const skipped = [];

for (const advisory of Object.values(advisories)) {
  const severity = advisory.severity;
  if (severity !== "high" && severity !== "critical") {
    continue;
  }
  const patched = advisory.patched_versions;
  const patchedText = patched === null || patched === undefined ? "" : String(patched).trim();
  const fixAvailable = patchedText.length > 0 && patchedText !== "<0.0.0";
  const ids = new Set(
    [advisory.github_advisory_id, advisory.id, advisory.url]
      .filter((value) => value !== undefined && value !== null)
      .map((value) => String(value)),
  );
  const label = `${advisory.module_name ?? "?"} ${advisory.github_advisory_id ?? advisory.id ?? ""} (${severity}) ${advisory.title ?? ""}`.trim();
  if (!fixAvailable) {
    unfixed.push(label);
    continue;
  }
  const matches = [...exceptions.entries()].filter(([id]) => ids.has(id));
  const fresh = matches.find(([, item]) => item.expires >= today);
  if (fresh) {
    skipped.push(`${label} — exception jusqu'au ${fresh[1].expires}`);
    continue;
  }
  if (matches.length > 0) {
    blocking.push(`${label} — exception expirée le ${matches[0][1].expires}`);
    continue;
  }
  blocking.push(`${label} — correctif ${patchedText}`);
}

for (const line of unfixed) {
  console.log(`SEC-SUPPLY-03 : sans correctif, non bloquant : ${line}`);
}
for (const line of skipped) {
  console.log(`SEC-SUPPLY-03 : ${line}`);
}
if (blocking.length > 0) {
  console.error("SEC-SUPPLY-03 : vulnérabilités élevées ou critiques avec correctif.");
  for (const line of blocking) {
    console.error(`- ${line}`);
  }
  process.exit(1);
}
console.log("SEC-SUPPLY-03 : aucune vulnérabilité élevée ou critique avec correctif.");
