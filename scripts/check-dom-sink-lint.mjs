/**
 * Preuve SEC-WEB-07 : le fixture des sinks DOM doit être rejeté par ESLint.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = fileURLToPath(new URL("../fixtures/dom-sinks.tsx", import.meta.url));

const expected = [
  "innerHTML",
  "outerHTML",
  "insertAdjacentHTML",
  "document.write",
  "document.writeln",
  "dangerouslySetInnerHTML",
  "eval",
  "Function",
  "Implied eval",
];

function lintFixture() {
  try {
    return {
      status: 0,
      stdout: execFileSync(
        "pnpm",
        ["exec", "eslint", "--no-ignore", "-f", "json", fixture],
        { cwd: root, encoding: "utf8" },
      ),
      stderr: "",
    };
  } catch (error) {
    return {
      status: typeof error.status === "number" ? error.status : 1,
      stdout: error.stdout?.toString() ?? "",
      stderr: error.stderr?.toString() ?? "",
    };
  }
}

const { status, stdout, stderr } = lintFixture();

if (status === 0) {
  console.error("SEC-WEB-07 : le fixture aurait dû être rejeté.");
  process.exit(1);
}

let results;
try {
  results = JSON.parse(stdout);
} catch {
  console.error("SEC-WEB-07 : sortie ESLint illisible.");
  console.error(stdout);
  console.error(stderr);
  process.exit(1);
}

const messages = results.flatMap((result) =>
  (result.messages ?? []).map(
    (message) => `${message.ruleId ?? "parse"}: ${message.message}`,
  ),
);

const missing = expected.filter(
  (token) => !messages.some((message) => message.includes(token)),
);

if (missing.length > 0) {
  console.error(`SEC-WEB-07 : sinks non signalés : ${missing.join(", ")}`);
  console.error(messages.join("\n"));
  if (stderr.length > 0) {
    console.error(stderr);
  }
  process.exit(1);
}

console.log("SEC-WEB-07 : sinks DOM rejetés par ESLint :");
for (const message of messages) {
  if (message.includes("SEC-WEB-07") || message.includes("eval") || message.includes("Function")) {
    console.log(`- ${message}`);
  }
}
