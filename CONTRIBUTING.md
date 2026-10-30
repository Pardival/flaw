# Contribuer à Flaw

*English below.*

Merci de votre intérêt ! Flaw est un projet modeste, maintenu sur le temps libre : les contributions ciblées et bien testées sont les plus faciles à accueillir.

## Avant de commencer

- Pour une correction simple (faute, bug évident), ouvrez directement une *pull request*.
- Pour une nouvelle fonctionnalité ou un changement d'interface, ouvrez d'abord un ticket pour en discuter : Flaw reste volontairement sobre.
- Une faille de sécurité ne se signale pas dans un ticket public : voir [SECURITY.md](SECURITY.md).

## Mettre en place l'environnement

Suivez le [démarrage rapide](README.md#démarrage-rapide-sur-votre-machine) : `corepack pnpm install`, puis `corepack pnpm local`.

## Règles du code

- **TypeScript strict**, imports avec extension `.ts`, pas de `any`.
- **Pile figée** : n'ajoutez pas de dépendance sans en discuter. Les licences acceptées sont MIT, ISC, BSD, Apache-2.0, PostgreSQL et OFL (polices) ; `corepack pnpm licenses:check` le vérifie.
- **Versions exactes** dans les `package.json` (pas de `^` ni de `~`).
- **Interface en français**, textes dans les catalogues i18next (`apps/web/src/i18n`), jamais en dur.
- Commentaires en français, concis, sur le *pourquoi* plutôt que le *quoi*.
- Le contenu des textes ne doit jamais apparaître dans les journaux, les URL ou les messages d'erreur.

## Avant d'ouvrir une pull request

```bash
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
```

Ajoutez des tests pour ce que vous changez. Décrivez dans la *pull request* le problème, la solution et la manière de la vérifier.

En contribuant, vous acceptez que votre contribution soit publiée sous la licence du projet, [AGPL-3.0-or-later](LICENSE).

---

# Contributing to Flaw

Thank you for your interest! Flaw is a small project maintained in spare time: focused, well-tested contributions are the easiest to accept.

- Simple fixes (typos, obvious bugs): open a pull request directly.
- New features or interface changes: open an issue first to discuss it; Flaw stays deliberately minimal.
- Security issues must not be reported publicly: see [SECURITY.md](SECURITY.md).

Setup: follow the [quick start](README.en.md#quick-start-on-your-machine).

Code rules: strict TypeScript; no new dependency without discussion (accepted licenses: MIT, ISC, BSD, Apache-2.0, PostgreSQL, OFL for fonts); exact versions in `package.json`; user-facing strings go through the i18next catalogs; text content must never reach logs, URLs or error messages.

Before opening a pull request, run `corepack pnpm lint`, `corepack pnpm typecheck` and `corepack pnpm test`, and add tests for your change.

By contributing, you agree that your contribution is published under the project license, [AGPL-3.0-or-later](LICENSE).
