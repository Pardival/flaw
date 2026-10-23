import { spawn } from "node:child_process";
import { createServer, get } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const chromeBin = "/usr/local/bin/google-chrome";
const html = `<!doctype html>
<meta charset="utf-8">
<title>pagination</title>
<div id="editor"></div>
<script type="module" src="/browser.js"></script>
`;

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(address.port);
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const request = get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        if ((response.statusCode ?? 500) >= 400) {
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }
        resolve(body);
      });
    });
    request.on("error", reject);
  });
}

function cdp(ws) {
  let next = 1;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id === undefined) return;
    const waiter = pending.get(message.id);
    if (waiter === undefined) return;
    pending.delete(message.id);
    if (message.error !== undefined) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  });
  return (method, params) =>
    new Promise((resolve, reject) => {
      const id = next;
      next += 1;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
}

const server = createServer((request, response) => {
  const url = request.url?.split("?")[0] ?? "/";
  if (url === "/" || url === "/index.html") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(html);
    return;
  }
  if (url === "/browser.js") {
    response.setHeader("content-type", "text/javascript; charset=utf-8");
    response.end(readFileSync(join(root, "dist", "browser.js")));
    return;
  }
  response.statusCode = 404;
  response.end("absent");
});

const httpPort = await listen(server);
const debugPort = 9300 + (httpPort % 500);
const chrome = spawn(
  chromeBin,
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    `--remote-debugging-port=${debugPort}`,
    "--user-data-dir=/tmp/flaw-pagination-chrome",
    `http://127.0.0.1:${httpPort}/`,
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
let chromeLog = "";
chrome.stderr.on("data", (chunk) => {
  chromeLog += String(chunk);
});

try {
  let socketUrl = "";
  for (let attempt = 0; attempt < 50 && socketUrl.length === 0; attempt += 1) {
    await sleep(200);
    try {
      const list = JSON.parse(await fetchText(`http://127.0.0.1:${debugPort}/json/list`));
      const page = list.find((item) => item.type === "page" && String(item.url).includes(String(httpPort)));
      socketUrl = page?.webSocketDebuggerUrl ?? "";
    } catch {
      socketUrl = "";
    }
  }
  if (socketUrl.length === 0) {
    throw new Error(`Chrome sans page de banc.\n${chromeLog}`);
  }
  const Socket = globalThis.WebSocket;
  const ws = new Socket(socketUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", () => reject(new Error("websocket Chrome")));
  });
  const send = cdp(ws);
  await send("Runtime.enable", {});
  let raw = "";
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const evaluated = await send("Runtime.evaluate", {
      expression: "document.getElementById('result')?.textContent || ''",
      returnByValue: true,
    });
    raw = evaluated.result?.value ?? "";
    if (raw.length > 0) break;
    await sleep(500);
  }
  ws.close();
  if (raw.length === 0) throw new Error(`Banc sans résultat.\n${chromeLog}`);
  const report = JSON.parse(raw);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (typeof report.error === "string") throw new Error(report.error);
  if (report.editingOk !== true) throw new Error("la frappe n'a pas modifié le document");
  if (report.contentVisibility !== "auto") {
    throw new Error(`content-visibility inattendu : ${report.contentVisibility}`);
  }
} finally {
  chrome.kill("SIGKILL");
  await new Promise((resolve) => server.close(resolve));
}
