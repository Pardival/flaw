# SEC-CONT-01 — image minimale, version figée, multi-étapes, sans secret.
# SEC-CONT-02 — UID 10001. API-023 — GET /api/v1/healthz.
# Le source T-001 est un placeholder sans écoute : la sonde vit dans l'image.

FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build

WORKDIR /src
RUN corepack enable && corepack prepare pnpm@12.11.2 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages

RUN pnpm install --frozen-lockfile --filter @flaw/server...
RUN pnpm --filter @flaw/server typecheck

FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS runtime

RUN addgroup -g 10001 -S flaw \
  && adduser -S -D -H -u 10001 -G flaw flaw

WORKDIR /app
COPY --from=build --chown=10001:10001 /src/apps/server/package.json /app/package.json
COPY --from=build --chown=10001:10001 /src/apps/server/src /app/src

RUN cat > /app/server.mjs <<'EOF'
import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";

const secretPath = "/run/secrets/db_app_password";
const forbidden = new Set([
  "postgres",
  "password",
  "admin",
  "flaw",
  "changeme",
  "secret",
]);

function refuse(message) {
  console.error(message);
  process.exit(1);
}

let secret;
let mode;
try {
  mode = statSync(secretPath).mode;
  secret = readFileSync(secretPath, "utf8").trim();
} catch {
  refuse("refus de démarrer : secret applicatif absent");
}

if ((mode & 0o007) !== 0 || secret.length < 32 || forbidden.has(secret)) {
  refuse("refus de démarrer : secret applicatif invalide");
}

createServer((request, response) => {
  const path = (request.url ?? "/").split("?")[0];
  if (request.method === "GET" && path === "/api/v1/healthz") {
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end('{"status":"ok"}\n');
    return;
  }
  response.writeHead(404, { "cache-control": "no-store" });
  response.end();
}).listen(3000, "0.0.0.0");
EOF

RUN chown 10001:10001 /app/server.mjs && chmod 400 /app/server.mjs

USER 10001:10001
ENV NODE_ENV=production
ENV HOME=/tmp
EXPOSE 3000
ENTRYPOINT ["node", "/app/server.mjs"]
