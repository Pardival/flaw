# flaw

Monorepo pnpm du projet Flaw (structure A-019).

## Prérequis

- Node.js 24 LTS (`engines` : `>=24 <25`)
- pnpm 12, version figée par `packageManager`

## Scripts

- `pnpm install --frozen-lockfile` — installation déterministe (SEC-SUPPLY-01)
- `pnpm lint` — ESLint, et preuve que les sinks DOM sont rejetés (SEC-WEB-07)
- `pnpm typecheck` — TypeScript `strict` sur les workspaces
- `pnpm licenses:check` — licences des dépendances (AC-092)

`.env` est ignoré. `.env.example` ne contient aucun secret (SEC-SECRET-01).
gitleaks est branché en pre-commit (SEC-SECRET-02).

`minimatch` est figé en 9.0.9 (ISC). La version 10 est sous BlueOak-1.0.0, absente de la liste A-002.

La licence du projet Flaw n'est pas décidée : ce dépôt n'a pas de fichier `LICENSE`.
