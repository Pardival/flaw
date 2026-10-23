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

## Configuration

`FLAW_AUTH_BEARER_ENABLED` vaut `false` par défaut (`infra/docker-compose.yml` et `infra/.env.example`). Seules les chaînes exactes `true` et `false` sont acceptées. Toute autre valeur (`TRUE`, `1`, `yes`) refuse le démarrage (« refus de démarrer : configuration invalide »). Le jeton `Authorization: Bearer` est réservé à un client mobile futur (SEC-SESS-06) : tant que le drapeau est éteint, il n'est pas lu. Une valeur absente équivaut à `false`.

`ALERT_WEBHOOK_URL` est vide (alerte désactivée) ou une URL `https`. Une URL `http` refuse le démarrage.

## Exploitation — flaw-admin

Les commandes s'exécutent sur le serveur (`docker compose exec app flaw-admin …`). L'accès SSH tient lieu de preuve d'identité. Aucune commande ne lit le contenu des documents. Chaque commande écrit un événement `admin.*`. `create-user`, `reset-password`, `disable-mfa`, `revoke-sessions`, `revoke-dek` et `rotate-kek` envoient en plus le nom de l'action à `ALERT_WEBHOOK_URL` (corps texte, rien d'autre). `check-roles` et `replay-erasures` sont journalisées sans cette alerte : les contrôles de rôles relèvent de l'assertion `infra/assert-app-role.sql`, le rejeu des effacements relève de T-051. Un échec de commande est aussi écrit dans `audit_events` (résultat `erreur`) lorsqu'un compte existe.

Le mot de passe provisoire (CSPRNG, 24 caractères, au moins 20) est écrit une seule fois sur la sortie standard. Il n'est pas journalisé. Il expire au bout de 24 h. La session qu'il ouvre est restreinte à 15 minutes et n'autorise que le changement de mot de passe, la déconnexion, l'enrôlement TOTP et la vérification du premier code. Le reste de l'API répond « session restreinte ». Tant que le TOTP n'est pas confirmé, une connexion dans les 24 h qui suivent l'émission du provisoire reste restreinte ; passé ce délai, la connexion est refusée jusqu'à un nouveau provisoire. Un appareil de confiance est un secret aléatoire dans le cookie `__Host-flaw_device` (HttpOnly, Secure, SameSite=Strict, Path=/, sans Domain, 90 jours), stocké seulement sous forme de hachage. Le User-Agent ne suffit pas.

- `create-user --email <identifiant>` crée le compte unique. `--password-stdin` permet de fournir un mot de passe choisi, lu sur l'entrée standard, jamais en argument.
- `reset-password --email <identifiant>` révoque toutes les sessions, impose un nouveau mot de passe provisoire et conserve le TOTP. L'ancien mot de passe et les anciennes sessions sont refusés. Le nouveau mot de passe doit être changé avant tout accès au contenu.
- `disable-mfa --email <identifiant>` est le dernier recours (téléphone et codes de secours perdus). La commande révoque les sessions, retire le TOTP et les codes, puis émet un mot de passe provisoire. L'ancien mot de passe ne peut plus enrôler un TOTP.
- `revoke-sessions --email <identifiant>` révoque les sessions sans afficher de mot de passe.
- `revoke-dek --email <identifiant> --dek-id <uuid>` passe la DEK au statut `revoked`. Une DEK `revoked` ne peut plus changer de statut, être supprimée directement, ni être réinsérée sous le même identifiant. La suppression en cascade d'un compte reste possible.
- `rotate-kek --kek-id <id> --new-kek-file <chemin>` ré-enveloppe toutes les DEK sous la nouvelle KEK, met à jour `user_keys.key_id` et vérifie le déballage. L'ancienne KEK passe au statut `retired` : elle ne sert plus à chiffrer et reste disponible pour déchiffrer jusqu'à la fin de la rétention des sauvegardes. Aucun fichier n'est supprimé, y compris lorsque `/run/secrets/flaw_kek` est monté en lecture seule : la commande n'essaie pas de le détruire et affiche « kek tournée, retirer l'ancien secret », puis comment installer le nouveau secret et régler `FLAW_KEK_ID` avant de redémarrer. Le fichier de la nouvelle KEK doit être en mode `0400`. Un fichier en `0644` produit « refus de démarrer : kek » (et « la nouvelle KEK doit être en mode 0400 ») sans rien modifier. Un identifiant déjà actif produit « kek inattendue ». Entre la rotation validée et le redémarrage, l'application encore en mémoire refuse les enrôlements et les codes TOTP échouent : il faut redémarrer. La destruction planifiée de l'ancienne KEK est hors périmètre (T-042). Les codes de secours (HMAC du poivre courant, pas de la KEK) restent valides. Une DEK `revoked` est ré-enveloppée et reste non résoluble ; une connexion qui en dépend est refusée par un message générique, et le journal de sécurité porte `admin.dek_revoked` à destination de l'exploitant. `retired` reste résoluble.
- `check-roles` compare les droits à `infra/assert-app-role.sql`.
- `replay-erasures` est exposée et journalisée en échec. Elle sort un code non nul et affiche « non implémenté (T-051) ». Elle ne rejoue rien : cette logique appartient à T-051.

Il n'y a pas de courriel, pas d'inscription publique, et pas de route pour désactiver le MFA. Le TOTP suit RFC 6238 (fenêtre ±1 pas). Le rejeu d'un même pas est refusé. Un code de secours consommé ouvre une session de reconfiguration : les anciens codes sont invalidés seulement lorsque de nouveaux codes sont émis.
