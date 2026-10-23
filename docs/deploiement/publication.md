# Publication de l'image sur GHCR

Le workflow `.github/workflows/release.yml` est distinct de `ci.yml`. Il construit l'image du serveur (`apps/server/Dockerfile`, la même que les services `app` et `migrate`) et la publie sur `ghcr.io`. Il ne déploie pas cette image sur l'hôte.

## Déclenchement

Seul un push de tag `v*` lance le workflow (`v1.2.3`, par exemple). Aucune branche, aucune exécution manuelle.

Le tag doit viser un commit qui contient déjà ce workflow (après fusion sur `main`). Le job de publication attend ensuite l'approbation de l'environment `publication`. Les contrôles du job précédent s'exécutent avant cette approbation ; s'ils échouent, aucune image n'est poussée.

## Environment protégé

Le job de publication est lié à l'environment GitHub `publication`. Avant le premier tag, un administrateur du dépôt configure :

- au moins un relecteur obligatoire ;
- les déploiements limités aux tags protégés `v*` (aucune branche).

Sans ces deux réglages, l'environment n'est pas protégé : ne pas pousser de tag avant qu'ils soient en place. L'environment ne contient aucun secret.

## Droits et jeton

Le workflow n'a que `contents: read`. Le job de publication ajoute `packages: write`, et lui seul. La connexion à `ghcr.io` utilise `GITHUB_TOKEN`. Aucun jeton personnel, aucun secret en clair dans le dépôt ni dans le journal (le jeton passe par l'entrée standard de `docker login`).

## Contrôles avant publication

- SEC-SUPPLY-01 : `pnpm install --frozen-lockfile`. Le Dockerfile répète cette installation déterministe. Le lockfile versionné fait échouer le job s'il ne correspond pas au manifeste.
- SEC-SUPPLY-03 : `node scripts/check-audit.mjs`. Les avis élevés et critiques qui ont un correctif bloquent la publication. Une exception documentée porte un identifiant, une date d'expiration et un motif (`.github/audit-exceptions.json`, s'il existe). Une exception échue redevient bloquante.
- SEC-SECRET-02 : gitleaks 8.30.1, archive vérifiée par empreinte, sur l'historique joignable depuis le tag. Une fuite bloque la publication. Le rapport est redacté.
- Chaque action est épinglée par un SHA de 40 caractères (le tag n'est qu'un commentaire).

## FLAW_IMAGE

L'image publiée est `ghcr.io/<propriétaire en minuscules>/flaw:<tag du git>`, avec le tag `v*` tel quel. Le résumé du job de publication affiche la ligne à copier dans `infra/.env` :

```
FLAW_IMAGE=ghcr.io/<propriétaire>/flaw:v1.2.3@sha256:<64 caractères hexadécimaux>
```

La référence porte le tag de version et l'empreinte `sha256`. Ne pas utiliser `latest`. Les services `app` et `migrate` lisent `FLAW_IMAGE`.
