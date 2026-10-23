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
RUN pnpm --filter @flaw/crypto build
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
COPY --from=build /src/apps/server/openapi /app/apps/server/openapi
# Le schéma est du TypeScript. Node refuse de le charger sous node_modules.
COPY --from=build /src/packages/schema/package.json /app/packages/schema/package.json
COPY --from=build /src/packages/schema/src /app/packages/schema/src
COPY infra/droits-flaw.sql infra/assert-app-role.sql /app/infra/
COPY apps/server/bin/flaw-admin /usr/local/bin/flaw-admin
RUN dep_nm="$(dirname "$(dirname "$(readlink -f /app/node_modules/@flaw/schema)")")" \
  && mkdir -p /app/packages/schema/node_modules \
  && ln -s "$dep_nm/parse5" /app/packages/schema/node_modules/parse5 \
  && ln -s "$dep_nm/prosemirror-model" /app/packages/schema/node_modules/prosemirror-model \
  && rm /app/node_modules/@flaw/schema \
  && ln -s /app/packages/schema /app/node_modules/@flaw/schema \
  && chmod 555 /usr/local/bin/flaw-admin \
  && chown -R root:root /app \
  && chmod 444 /app/infra/droits-flaw.sql /app/infra/assert-app-role.sql \
  && chmod -R a-w /app \
  && chmod -R a+rX /app \
  && node --input-type=module -e "import('pg').then(() => import('@flaw/schema/src/index.ts')).then((schema) => { if (typeof schema.documentFromJson !== 'function') process.exit(1); }).then(() => import('./apps/server/src/platform/openapi.ts')).then((openapi) => { const doc = openapi.buildOpenApiDocument(); if (doc.paths['/api/v1/healthz'] === undefined) process.exit(1); }).then(() => import('drizzle-orm')).then(() => import('@flaw/crypto')).then(async (crypto) => { if (typeof crypto.wrapDek !== 'function') process.exit(1); const { createRequire } = await import('node:module'); const argon2 = createRequire(import.meta.url)('@node-rs/argon2'); const material = 'construction-argon2id'; const hashed = await argon2.hash(material, { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 }); if (!hashed.startsWith('\$argon2id\$') || !(await argon2.verify(hashed, material)) || (await argon2.verify(hashed, 'autre-mot'))) process.exit(1); }).catch((error) => { console.error(error); process.exit(1); })"

USER 10001:10001
ENV NODE_ENV=production
ENV HOME=/tmp
EXPOSE 3000
CMD ["node", "apps/server/src/app.ts"]
