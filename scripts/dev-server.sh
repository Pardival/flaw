#!/bin/sh
# Serveur API Flaw en développement local : base Docker « flaw-dev-db » sur 127.0.0.1:55432,
# secrets générés dans .dev/secrets (jamais commités). L'app web passe par le proxy Vite.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
S="$ROOT/.dev/secrets"
# Node 24 (engines) : celui de nvm s'il est installé, sinon celui du PATH.
NODE=$(ls -d "$HOME"/.nvm/versions/node/v24.*/bin/node 2>/dev/null | tail -1)
NODE=${NODE:-node}
export NODE_ENV=development LOG_LEVEL=info PORT=3000
export PUBLIC_URL=http://localhost:5173 TRUSTED_ORIGINS=http://localhost:5173 TRUSTED_PROXY_CIDR=127.0.0.1/32
export DATABASE_HOST=127.0.0.1 DATABASE_PORT=55432 DATABASE_NAME=flaw DATABASE_USER=flaw_app
export DATABASE_PASSWORD_FILE="$S/app_db_password" BETTER_AUTH_SECRET_FILE="$S/better_auth_secret"
export BETTER_AUTH_URL=http://localhost:5173
export FLAW_KEK_FILE="$S/flaw_kek" FLAW_KEK_ID=kek-dev-2026
export RECOVERY_PEPPER_FILE="$S/recovery_pepper" RECOVERY_PEPPER_ID=pep-dev-2026
export HMAC_PEPPER_FILE="$S/hmac_pepper" HMAC_PEPPER_ID=pep-hmac-dev-2026
export ALLOW_SIGNUP=false FLAW_AUTH_BEARER_ENABLED=false
# Usage maison : pas d'écran de connexion, l'app agit comme le compte local (développement seulement).
export FLAW_DEV_NO_AUTH="${FLAW_DEV_NO_AUTH:-true}"
echo "Flaw : connexion désactivée (FLAW_DEV_NO_AUTH=$FLAW_DEV_NO_AUTH, développement local)" >&2
cd "$ROOT"
exec "$NODE" apps/server/src/app.ts
