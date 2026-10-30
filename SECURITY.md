# Sécurité / Security

## Signaler une faille

Merci de **ne pas ouvrir de ticket public**. Utilisez le signalement privé de GitHub : onglet *Security* du dépôt, puis *Report a vulnerability*. Décrivez la faille, comment la reproduire et son impact. Vous recevrez une réponse dès que possible ; une correction sera publiée avant toute divulgation.

## Périmètre

- **Mode local** (`corepack pnpm local`) : la connexion est désactivée par conception et le serveur n'écoute que `127.0.0.1`. Qu'une personne ayant déjà accès à la machine puisse lire les textes n'est pas une faille.
- **Déploiement serveur** : connexion par mot de passe et double authentification (TOTP), sessions en cookie `HttpOnly`, chiffrement des textes au repos (enveloppe KEK → DEK, XChaCha20-Poly1305), isolation des comptes par *row-level security* PostgreSQL, imports traités dans un *worker* sans accès réseau.

---

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub private reporting: the repository's *Security* tab, then *Report a vulnerability*. Describe the issue, how to reproduce it and its impact. You will get an answer as soon as possible, and a fix will be released before any disclosure.

Local mode (`corepack pnpm local`) disables sign-in by design and only listens on `127.0.0.1`; someone who already has access to the machine being able to read texts is not a vulnerability.
