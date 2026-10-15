# SEC-CONT-01 — image minimale, version figée, multi-étapes, sans secret.
# SEC-CONT-02 — UID 10001. Le CMD est le serveur Fastify : node apps/server/src/app.ts.
# Le service migrate lance apps/server/src/db/migrate.ts et lit apps/server/drizzle.

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
COPY --from=build /src/apps/server/package.json /app/apps/server/package.json
COPY --from=build /src/apps/server/src /app/apps/server/src
COPY --from=build /src/apps/server/drizzle /app/apps/server/drizzle
COPY infra/droits-flaw.sql infra/assert-app-role.sql /app/infra/
COPY apps/server/bin/flaw-admin /usr/local/bin/flaw-admin
RUN chmod 555 /usr/local/bin/flaw-admin \
  && chown -R root:root /app \
  && chmod 444 /app/infra/droits-flaw.sql /app/infra/assert-app-role.sql \
  && chmod -R a-w /app \
  && chmod -R a+rX /app \
  && node --input-type=module -e "import('pg').then(() => import('drizzle-orm')).then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); })"

USER 10001:10001
ENV NODE_ENV=production
ENV HOME=/tmp
EXPOSE 3000
CMD ["node", "apps/server/src/app.ts"]
