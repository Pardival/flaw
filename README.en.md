# Flaw

**Distraction-free writing, on a real book page.**

*[Version française](README.md)*

Flaw is a free and open-source writing app built for long-form work: novels, screenplays, essays, journals. You write directly on a page at its real size (trade paperback, A4, US Letter…), with margins, page numbers and page breaks, and no menus cluttering the screen. Everything is saved on your device, even offline, then synced with your own server.

> The interface is currently in French. Contributions to translate it are welcome (i18next catalogs live in `apps/web/src/i18n`).

## Features

- **Four writing modes**
  - *Novel*: chapters, running heads, numbered pages.
  - *Screenplay*: scene heading, action, character, dialogue, transition (standard layout).
  - *Document*: headings, lists, paragraphs.
  - *Blank page*: no structure, just text.
- **A real page**: pagination measured on the rendered text, line-accurate breaks, page number at the foot of every page.
- **Automatic French typography**: non-breaking spaces before `; : ! ?`, « » quotes, `--` becomes a dialogue dash "—".
- **Focus mode**: a small box in the middle of the screen, showing only the last few lines.
- **Local-first**: writing never waits for the network; sync (Yjs) catches up when the connection returns.
- **Version history**, 30-day trash, daily word goal.
- **Import** Word, Markdown, plain text; **export** PDF, Word, EPUB, Fountain, processed on the device.
- **Encryption at rest** on the server (KEK → DEK envelope, XChaCha20-Poly1305).
- Light and dark themes, installable as an app (PWA).

## Quick start (on your machine)

Requirements: [Docker](https://docs.docker.com/get-docker/), [Node.js 24](https://nodejs.org/) and `openssl`.

```bash
git clone https://github.com/Pardival/flaw.git
cd flaw
corepack enable
corepack pnpm install
corepack pnpm local
```

Then open <http://localhost:5173>. On first run, the command generates secrets in `.dev/secrets` (never committed), creates the PostgreSQL database in Docker, applies migrations and creates the local account. Later runs pick up where you left off.

On the empty home screen, **Découvrir avec des exemples** loads four demo texts, one per mode.

| Command | Effect |
| --- | --- |
| `corepack pnpm local` | starts Flaw (database, server, interface) |
| `corepack pnpm local:stop` | stops the database (your texts are kept) |
| `corepack pnpm local:reset` | deletes the local database and secrets, after confirmation |

> **Local mode = one person, on this machine.** To keep things simple, sign-in is disabled (`FLAW_DEV_NO_AUTH`): anyone who can reach the server acts as the local account. This mode is refused outside `NODE_ENV=development` and only listens on `localhost`. Never expose it on a network. For an online server, see [docs/deploiement](docs/deploiement/publication.md).

## Development

```bash
corepack pnpm lint        # ESLint (and rejection of dangerous DOM sinks)
corepack pnpm typecheck   # strict TypeScript across all packages
corepack pnpm test        # Vitest; database tests start PostgreSQL in Docker
corepack pnpm licenses:check
```

Repository layout (pnpm monorepo):

| Folder | Contents |
| --- | --- |
| `apps/web` | React 19 + Vite interface, ProseMirror editor, local storage (IndexedDB) |
| `apps/server` | Fastify 5 API, Hocuspocus sync, PostgreSQL 18 with row-level security |
| `packages/schema` | shared document schema (ProseMirror) |
| `packages/sync` | shared sync protocol |
| `packages/crypto` | envelope encryption |
| `packages/importers`, `packages/exporters` | Word / Markdown / text import; PDF (Typst), Word, EPUB, Fountain export |
| `infra` | Docker Compose, Caddy, backups |
| `docs` | decisions, deployment, [technical reference](docs/reference-technique.md) (French) |

## Contributing

Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). To report a security vulnerability, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## License

Flaw is free software under the [GNU AGPL-3.0-or-later](LICENSE): you may use, study, modify and redistribute it. If you offer a modified version as an online service, you must publish its source code.

The bundled fonts (EB Garamond, Courier Prime, Source Serif 4, Inter, and the others in `assets/fonts`) are licensed under the SIL Open Font License 1.1; their license texts sit next to the files.

© 2026 Kevin Dufour and the Flaw contributors.
