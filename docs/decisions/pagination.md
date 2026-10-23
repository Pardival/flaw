# DEC — Pagination longue : niveau 1

T-016, mesuré depuis `main@97ef832d` (T-015). `packages/schema/` n'est pas modifié.

## Décision

**Niveau 1.** Un seul éditeur ProseMirror pour tout le texte. Les blocs restent dans le DOM avec `content-visibility: auto`. La pagination est un `DecorationSet` : le chapitre courant est mis en pages hors de la frappe, les chapitres lointains restent estimés et leur folio affiché est « … ».

Le budget AC-087 tient sur ce chemin. Le niveau 2 (un éditeur par chapitre, `Y.XmlFragment`) n'est pas retenu.

`SCHEMA_VERSION` reste l'entier provisoire `1` de T-015. La pagination n'ajoute ni nœud ni marque : elle ne demande pas de l'incrémenter, et ce document ne fige pas la version.

## Mesure

Roman de 150 000 mots construit avec `@flaw/schema` : 3 780 blocs, 30 chapitres, format `novel_13x20`, surface téléphone (colonne fluide, sauts marqués). Curseur au milieu du livre. 5 frappes d'échauffement, puis 40 frappes. Chaque échantillon couvre la transaction, le compteur du bloc touché, le mapping des décorations, la mise à jour du DOM et le rectangle du bloc du curseur. L'attente du frame suivant (~16,7 ms même à vide) n'est pas comptée dans le budget.

Machine : Xeon virtualisé, 4 vCPU, Chrome headless 156.0.8078.47. Ce n'est pas un téléphone. Le passage au milieu de gamme multiplie le temps par **3** (`PHONE_SLOWDOWN`). Le niveau 1 n'est retenu que si `p95 × 3 < 16`.

Deux passages du chemin spécifié (seul le chapitre courant est mesuré) :

- p95 mise en page : **0,7 ms** puis **0,8 ms** (p95 du seul JS : 0,6 ms puis 0,8 ms)
- retenu pour la décision : **0,8 × 3 = 2,4 ms**, sous 16 ms
- la frappe insère bien le caractère ; `content-visibility` calculé sur un paragraphe vaut `auto`

Le même chemin sur tablette (colonne aux proportions 13×20) : p95 0,9 ms puis 0,7 ms.

Même document, les 30 chapitres décorés (779 widgets) : p95 4,5 ms puis 3,1 ms. Le plus haut reste sous le budget à ×3 (13,5 ms). Le maximum observé, 8,8 ms, passerait à 26 ms sur téléphone et raterait un frame. Les chapitres lointains doivent donc rester estimés : c'est la condition du niveau 1, déjà posée par A-005.

Un éditeur réduit au chapitre courant (~5 000 mots) : p95 0,2 ms. Utile comme plan B, pas nécessaire pour le budget.

Le seul modèle, sans DOM, reste aussi sous 16 ms (test `node --test`). Ce chiffre ne décide pas : la décision vient du banc Chrome.

## Ce que le prototype fixe, et ce qu'il suppose

Le chemin de frappe ne remesure rien. Il recopie les comptes de mots des blocs inchangés (identité ProseMirror) et mappe les décorations déjà posées. Le titre du livre (`title`) reste distinct des titres de chapitre. Insérer un chapitre est une transaction : le curseur est dans le nouveau `chapter_title`, et ce titre ouvre une page.

Les formats et leurs défauts sont ceux du tableau § 5.4 (`novel_13x20`, poche 11×17,8, 15×23, A5, A4, US Letter). Sur téléphone la page est fluide et les sauts sont marqués ; sur tablette et ordinateur la colonne a les proportions du format, marges déduites.

Les millimètres de marge ne sont ni dans le paquet T-016 ni dans le dépôt. Le prototype suppose 1,5 cm de chaque côté (roman, document, page blanche) et les marges classiques du script (1,5 po à gauche, 1 po ailleurs). Le corps roman est à 11 pt, comme l'exemple du contrat API. Ces hypothèses changent le nombre de mots par page, pas le choix de niveau.

## Rejouer

```bash
cd prototypes/pagination
pnpm install --ignore-workspace
pnpm check
pnpm bench
```

Le prototype est hors workspace (`apps/*`, `packages/*`). Son lockfile est le sien. `@flaw/schema` est importé par chemin relatif, sans copie et sans modification.
