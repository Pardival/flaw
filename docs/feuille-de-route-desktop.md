# Feuille de route — Flaw Desktop (100 % local)

Objectif : une application de bureau Windows et macOS, téléchargeable, sans compte ni serveur, dont les textes restent sur la machine. La version serveur (connexion, synchronisation) reste dans le dépôt mais n'est pas embarquée.

## Étape 1 — Mode « local seul » dans l'interface web
- Ajouter une cible de build `VITE_FLAW_TARGET=desktop`.
- Dans cette cible :
  - pas d'écrans de connexion ni de double authentification ;
  - pas de client de synchronisation (Hocuspocus) ni d'appel `/api` ;
  - IndexedDB (Dexie) devient la seule source de vérité.
- Retirer de l'interface tout ce qui suppose un serveur : statut de synchro, sessions, compte.
- Faire tourner historique, corbeille, import et export sans réseau (les exports sont déjà calculés sur l'appareil).
- Ajouter une sauvegarde sur disque : export/import complet de la bibliothèque, plus une copie automatique dans un dossier choisi.

## Étape 2 — Coquille de bureau (Tauri 2)
- Tauri (MIT/Apache) plutôt qu'Electron : environ 10 Mo au lieu de 150, et il réutilise le build Vite tel quel.
- CSP stricte, aucune API Tauri exposée hors du strict nécessaire :
  - dialogues ouvrir/enregistrer pour l'import, l'export et les sauvegardes ;
  - ouverture des liens externes.
- Fenêtre, icône, menu natif minimal, raccourcis.
- Production des fichiers :
  - Windows : `.msi` / `.exe` ;
  - macOS : `.dmg` universel Intel + Apple Silicon.

## Étape 3 — Tests et performances
- Parcours de bout en bout (Playwright) : accueil → créer → écrire → chapitres → focus → réglages → export → corbeille → retour.
- Mesures :
  - temps de démarrage ;
  - latence de frappe (cible : moins de 16 ms) ;
  - pagination d'un roman de 300 pages ;
  - mémoire ;
  - fluidité des transitions (images par seconde).
- Corriger ce qui dépasse les cibles.

## Étape 4 — Corrections signalées
- Alignements (centrer, etc.) depuis le menu de sélection : à diagnostiquer. La commande et la CSS existent ; une règle plus spécifique ou une perte de sélection l'emporte probablement.
- Menu de sélection : apparition et disparition animées (fondu + légère montée), suivi doux de la sélection.

## Étape 5 — Nouvelles fonctionnalités
- **Import PDF**
  - Avec pdf.js (Apache-2.0), dans le worker d'import sans réseau.
  - On récupère le texte et les paragraphes, pas la mise en page : un PDF n'en garde pas la structure.
- **Images**
  - Un nouveau nœud `image` dans le schéma, stocké localement (IndexedDB), jamais d'URL externe.
  - Insertion par bouton ou glisser-déposer.
  - Redimensionnement à la souris, recadrage, centrage.
  - Prise en compte par la pagination et les exports PDF, Word et EPUB.
- **Couvertures (1re et 4e)**
  - Un bouton « Couverture » dans l'éditeur ouvre un atelier :
    - 1re : image, titre, auteur, quelques modèles ;
    - 4e : résumé, texte libre.
  - Aperçu au format du livre, export PDF avec les couvertures.

## Étape 6 — Distribution
- Construction automatique sur GitHub Actions (runners macOS et Windows) à chaque version taguée, publiée dans GitHub Releases.
- Page de téléchargement (GitHub Pages) : présentation, captures, bouton Windows et bouton macOS qui pointent vers la dernière version.
- Signature :
  - sans signature, macOS (Gatekeeper) et Windows (SmartScreen) affichent un avertissement à l'installation ;
  - signer coûte environ 99 $/an pour Apple (Developer ID + notarisation), et un certificat Windows en plus. Décision à prendre avant la première version publique.

## Hors de cette version
- Synchronisation entre appareils, comptes, chiffrement serveur : conservés pour une éventuelle version hébergée.
