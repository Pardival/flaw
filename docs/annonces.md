# Textes d'annonce de Flaw

Textes prêts à coller. Liens utiles :

- Page : https://pardival.github.io/flaw/
- Code : https://github.com/Pardival/flaw
- Vidéos : `site/media/flaw-demo-fr.mp4`, `site/media/flaw-demo-en.mp4`
- Captures : `site/media/*.jpg`

À dire partout : libre (AGPL-3.0), gratuit, 100 % local, Mac et Windows. Pas encore de version Linux. Pas de signature payante : une confirmation est demandée au premier lancement.

---

## Framalibre (fiche)

**Nom :** Flaw
**Catégorie :** Bureautique › Traitement de texte / Écriture
**Licence :** AGPL-3.0
**Systèmes :** macOS, Windows
**Site :** https://pardival.github.io/flaw/

**Résumé (une phrase) :** Logiciel d'écriture pour romans, scénarios et essais, qui met le texte en page sur une vraie page de livre, entièrement hors ligne.

**Description :**

Flaw est un logiciel d'écriture pensé pour les textes longs. On écrit directement sur une page au format réel (roman broché, poche, A4, US Letter) : marges, numéros de page et sauts de page s'affichent pendant la frappe, sans menus qui encombrent l'écran.

- Quatre modes : roman (chapitres, en-têtes), script de film (mise en page standard), document, page blanche.
- Typographie française automatique : espaces insécables, guillemets « », tiret de dialogue.
- Images (recadrage, alignement) et atelier de couverture pour la 1re et la 4e.
- Import Word, PDF, Markdown, texte ; export PDF prêt à imprimer, Word, EPUB, Fountain.
- Versions précédentes, corbeille, sauvegarde de toute la bibliothèque dans un fichier.
- Interface en français, anglais, espagnol, allemand, italien et portugais.

Aucun compte et aucun serveur : les textes restent sur l'ordinateur.

---

## LinuxFr.org (journal)

**Titre :** Flaw, un logiciel libre pour écrire des livres sur de vraies pages

Bonjour à tous,

Je viens de publier la première version de Flaw, un logiciel d'écriture libre (AGPL-3.0) pour les romans, scénarios et essais.

L'idée : écrire directement sur une page au format du livre final. La mise en page se fait pendant qu'on tape (marges, numéros, chapitres sur une nouvelle page), avec une typographie française soignée (espaces insécables, guillemets, tiret de dialogue `--` → « — »). Les menus s'effacent pendant l'écriture et un mode focus ne garde que les dernières lignes.

Ce qu'il sait faire aujourd'hui :

- roman, script de film (format standard), document, page blanche ;
- images recadrables et atelier de couverture (1re et 4e) ;
- import Word, PDF, Markdown ; export PDF (composé avec Typst, en local), Word, EPUB, Fountain ;
- historique des versions, sauvegarde complète en un fichier ;
- six langues d'interface.

Côté technique : TypeScript, React, ProseMirror et Yjs. L'application de bureau utilise Tauri (environ 15 Mo). Tout se passe en local : aucun compte, aucune télémétrie. Le PDF est composé dans le navigateur grâce à Typst compilé en WebAssembly. Le dépôt contient aussi une version serveur auto-hébergeable (Fastify, PostgreSQL, chiffrement au repos), pour qui veut synchroniser plusieurs appareils.

Il n'y a pas encore de paquet Linux : Tauri le permet, et c'est la prochaine étape si cela vous intéresse. Les contributions sont les bienvenues, et les retours encore plus.

- Téléchargement : https://pardival.github.io/flaw/
- Code : https://github.com/Pardival/flaw

---

## Mastodon

**Français :**

J'ai publié Flaw, un logiciel libre pour écrire des livres sur de vraies pages : roman, scénario, essai.

📖 Mise en page pendant qu'on écrit
✍️ Typographie française automatique
🖼 Images et couvertures
🔒 100 % local, sans compte

Mac et Windows, gratuit, AGPL.
https://pardival.github.io/flaw/

#LogicielLibre #Écriture #AutoÉdition #Roman

**English:**

I just released Flaw, a free and open-source app for writing books on real pages: novels, screenplays, essays.

📖 Laid out as you type
🖼 Images and cover design
📤 PDF, Word, EPUB export
🔒 Fully local, no account

Mac & Windows, AGPL.
https://pardival.github.io/flaw/

#OpenSource #Writing #SelfPublishing #AmWriting

---

## Reddit

**r/ecriture, r/france (français)**

**Titre :** J'ai créé un logiciel d'écriture gratuit qui met votre roman en page pendant que vous écrivez

Bonjour,

Je travaille sur Flaw, un logiciel d'écriture libre et gratuit pour Mac et Windows. On écrit directement sur une page au format du livre (poche, broché, A4…), avec la typographie française faite automatiquement : espaces insécables, guillemets « », tiret de dialogue quand on tape `--`.

Il y a aussi un mode script de film, l'import Word et PDF, l'export PDF prêt à imprimer, EPUB et Word, des images, et un atelier pour composer la 1re et la 4e de couverture. Tout reste sur votre ordinateur : pas de compte, pas d'abonnement.

C'est la première version, et je cherche des retours d'auteurs et d'autrices : qu'est-ce qui vous manque ? Qu'est-ce qui vous gêne ?

https://pardival.github.io/flaw/

**r/writing, r/selfpublish (English)**

**Title:** I built a free, offline writing app that lays out your book as you type

Hi all,

I've been working on Flaw, a free and open-source writing app for Mac and Windows. You write directly on a page at your book's real size (trade paperback, pocket, A4, US Letter): margins, page numbers and chapter breaks appear as you type, and the menus fade away while you write.

It also has a screenplay mode, Word/PDF import, print-ready PDF, EPUB and Word export, images, and a small studio for front and back covers. Everything stays on your computer: no account, no subscription.

It's a first release, and I'd love feedback from people who write long-form: what's missing, and what gets in your way?

https://pardival.github.io/flaw/

**r/screenwriting:** reprendre le texte anglais en mettant en avant le mode script (format standard, export Fountain et PDF).

**r/opensource, r/macapps:** reprendre le texte anglais et ajouter la pile technique (Tauri, ProseMirror, Yjs, Typst en WebAssembly).

---

## AlternativeTo

**Alternative à :** Scrivener, Ulysses, iA Writer, Vellum, Final Draft (mode script)

**Description :** Free and open-source writing app for novels, screenplays and essays. You write on a real book page: layout, page numbers and chapters as you type. It handles French typography, images, cover design, Word/PDF import, and PDF/EPUB/Word export. Fully local, no account. Mac and Windows.

**Mots-clés :** writing, novel, screenplay, distraction-free, offline, book-layout, epub, open-source

---

## Hacker News (Show HN)

**Title:** Show HN: Flaw – a local-first writing app that lays out your book as you type

**Text:**

Flaw is a writing app for long-form text (novels, screenplays, essays) where you write directly on a page at its real print size. Pagination is measured on the rendered text, so breaks fall on the exact line, and the PDF export uses the same layout (Typst compiled to WebAssembly, running locally).

Stack: TypeScript, React, ProseMirror with Yjs for the document model, IndexedDB for storage, and Tauri for the desktop shell (~15 MB). There is no account and no telemetry; the only native command the page can call is "Save as…". The repo also contains an optional self-hosted server (Fastify + Postgres, envelope encryption at rest) for multi-device sync.

Things I'd love feedback on: pagination performance on very long books, the PDF import heuristics (rebuilding paragraphs from positioned text), and whether a Linux build would be useful.

https://github.com/Pardival/flaw

---

## Product Hunt

**Nom :** Flaw
**Accroche (60 caractères) :** Write your book on a real page, fully offline
**Description :** Flaw is a free, open-source writing app for novels, screenplays and essays. You write on a real book page with layout, page numbers and chapters as you type. Add images, design your front and back cover, and export print-ready PDF, EPUB or Word. No account, no cloud: everything stays on your computer.
**Premier commentaire :** expliquer pourquoi Flaw existe (écrire sans distraction tout en voyant le livre prendre forme), ce qui est prévu ensuite (Linux, plus de langues), et demander des retours.
**Médias :** la vidéo anglaise, puis les captures `en-02-ecrire`, `en-03-image`, `en-05-couverture`, `en-06-quatrieme`.
