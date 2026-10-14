# SEC-CONT-01 — image minimale, version figée, multi-étapes, sans secret.
# SEC-CONT-02 — UID 10001. API-023 — le processus est src/platform/healthz.ts.
# Aucun serveur de santé n'est écrit dans cette image.

FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build

WORKDIR /src
RUN corepack enable && corepack prepare pnpm@12.11.2 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @flaw/server typecheck
RUN pnpm --filter @flaw/server deploy --prod /out

FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS runtime

RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
  && addgroup -g 10001 -S flaw \
  && adduser -S -D -H -u 10001 -G flaw -h /tmp flaw

WORKDIR /app
COPY --from=build /out/ /app/
COPY --from=build /src/apps/server/src/platform/healthz.ts /app/src/platform/healthz.ts
RUN chown -R root:root /app \
  && chmod -R a-w /app \
  && chmod -R a+rX /app \
  && node --input-type=module -e "import('pg').then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); })"

USER 10001:10001
ENV NODE_ENV=production
ENV HOME=/tmp
EXPOSE 3000
CMD ["node", "src/platform/healthz.ts"]
