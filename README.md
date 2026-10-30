# Flaw

**Écrire sans distraction, sur une vraie page de livre.**

*[English version](README.en.md)*

Flaw est une application d'écriture libre, pensée pour les textes longs : romans, scénarios, essais, journaux. On écrit directement sur une page au format réel (roman broché, A4, US Letter…), avec ses marges, son folio et ses sauts de page, sans menus qui encombrent l'écran. Tout est enregistré sur l'appareil, même hors ligne, puis synchronisé avec votre propre serveur.

## Télécharger

**Application de bureau pour Mac et Windows**, 100 % locale : ni compte, ni serveur, vos textes restent sur votre ordinateur.

- [Flaw pour Mac](https://github.com/Pardival/flaw/releases/latest/download/Flaw-mac.dmg) (macOS 11 ou plus, Intel et Apple Silicon)
- [Flaw pour Windows](https://github.com/Pardival/flaw/releases/latest/download/Flaw-windows.exe) (Windows 10 et 11, 64 bits)

L'application n'est pas signée par un certificat payant : au premier lancement, ouvrez-la via Réglages Système › Confidentialité et sécurité › « Ouvrir quand même » (Mac), ou « Informations complémentaires » › « Exécuter quand même » (Windows). Pensez à **Réglages › Données › Sauvegarder la bibliothèque** de temps en temps.

## Fonctionnalités

- **Quatre modes d'écriture**
  - *Roman* : chapitres, en-têtes courants, pages numérotées.
  - *Script de film* : scène, action, personnage, dialogue, transition (mise en page standard).
  - *Document* : titres, listes, paragraphes.
  - *Page blanche* : aucune structure, juste le texte.
- **Une vraie page** : pagination mesurée sur le rendu, coupure à la ligne près, folio en bas de chaque page.
- **Typographie française automatique** : espaces insécables avant `; : ! ?`, guillemets « », `--` devient un tiret de dialogue « — ».
- **Mode focus** : une boîte réduite au centre de l'écran, rien que les dernières lignes.
- **Local d'abord** : l'écriture ne dépend jamais du réseau ; la synchronisation (Yjs) rattrape quand la connexion revient.
- **Historique des versions**, corbeille de 30 jours, objectif de mots quotidien.
- **Import** Word, PDF, Markdown, texte brut ; **export** PDF, Word, EPUB, Fountain, traités sur l'appareil.
- **Chiffrement au repos** côté serveur (enveloppe KEK → DEK, XChaCha20-Poly1305).
- Thèmes clair et sombre, installable comme application (PWA).

## Démarrage rapide (sur votre machine)

Prérequis : [Docker](https://docs.docker.com/get-docker/), [Node.js 24](https://nodejs.org/) et `openssl`.

```bash
git clone https://github.com/Pardival/flaw.git
cd flaw
corepack enable
corepack pnpm install
corepack pnpm local
```

Ouvrez ensuite <http://localhost:5173>. Au premier lancement, la commande génère les secrets dans `.dev/secrets` (jamais commités), crée la base PostgreSQL dans Docker, applique les migrations et crée le compte local. Les lancements suivants reprennent là où vous en étiez.

Sur l'accueil vide, **Découvrir avec des exemples** charge quatre textes de démonstration, un par mode.

| Commande | Effet |
| --- | --- |
| `corepack pnpm local` | démarre Flaw (base, serveur, interface) |
| `corepack pnpm local:stop` | arrête la base (vos textes sont conservés) |
| `corepack pnpm local:reset` | supprime la base et les secrets locaux, après confirmation |

> **Mode local = une seule personne, sur cette machine.** Pour aller vite, la connexion est désactivée (`FLAW_DEV_NO_AUTH`) : toute personne qui atteint le serveur agit comme le compte local. Ce mode est refusé hors `NODE_ENV=development` et n'écoute que sur `localhost`. Ne l'exposez jamais sur un réseau. Pour un serveur accessible en ligne, voir [docs/deploiement](docs/deploiement/publication.md).

## Construire l'application de bureau

Prérequis supplémentaires : [Rust](https://rustup.rs/) (stable) et, sous Windows, les outils de compilation C++ de Visual Studio.

```bash
corepack pnpm --filter @flaw/desktop dev     # fenêtre de développement
corepack pnpm --filter @flaw/desktop build   # .dmg (Mac) ou installateur .exe (Windows)
```

Une version publique se publie en poussant un tag `desktop-vX.Y.Z` (même numéro que `apps/desktop/src-tauri/tauri.conf.json`) : le workflow `desktop` construit les deux systèmes et crée la version GitHub. La page de téléchargement (`site/`) est publiée par le workflow `pages`.

## Développement

```bash
corepack pnpm lint        # ESLint (et rejet des sinks DOM dangereux)
corepack pnpm typecheck   # TypeScript strict sur tous les paquets
corepack pnpm test        # Vitest ; les tests de base lancent PostgreSQL dans Docker
corepack pnpm licenses:check
```

Organisation du dépôt (monorepo pnpm) :

| Dossier | Contenu |
| --- | --- |
| `apps/web` | interface React 19 + Vite, éditeur ProseMirror, stockage local (IndexedDB) |
| `apps/desktop` | application de bureau Tauri 2 (Mac, Windows), 100 % locale |
| `site` | page de téléchargement (GitHub Pages) |
| `apps/server` | API Fastify 5, synchronisation Hocuspocus, PostgreSQL 18 avec RLS |
| `packages/schema` | schéma de document commun (ProseMirror) |
| `packages/sync` | protocole de synchronisation partagé |
| `packages/crypto` | chiffrement par enveloppe |
| `packages/importers`, `packages/exporters` | import Word / Markdown / texte ; export PDF (Typst), Word, EPUB, Fountain |
| `infra` | Docker Compose, Caddy, sauvegardes |
| `docs` | décisions, déploiement, [référence technique](docs/reference-technique.md) |

## Contribuer

Les contributions sont bienvenues : voir [CONTRIBUTING.md](CONTRIBUTING.md). Pour signaler une faille de sécurité, suivez [SECURITY.md](SECURITY.md) plutôt que d'ouvrir un ticket public.

## Licence

Flaw est un logiciel libre sous licence [GNU AGPL-3.0-or-later](LICENSE) : vous pouvez l'utiliser, l'étudier, le modifier et le redistribuer. Si vous proposez une version modifiée comme service en ligne, vous devez en publier le code source.

Les polices fournies (EB Garamond, Courier Prime, Source Serif 4, Inter, et les autres dans `assets/fonts`) sont sous licence SIL Open Font License 1.1 ; leurs textes de licence sont à côté des fichiers.

© 2026 Kevin Dufour et les contributeurs de Flaw.
