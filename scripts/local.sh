#!/bin/sh
# Flaw en local, en une commande : secrets, base PostgreSQL (Docker), migrations,
# compte local, puis serveur et interface. Usage maison sur cette machine uniquement :
# la connexion est désactivée (FLAW_DEV_NO_AUTH), jamais à exposer sur un réseau.
#
#   sh scripts/local.sh          démarre (ou reprend) Flaw sur http://localhost:5173
#   sh scripts/local.sh stop     arrête la base
#   sh scripts/local.sh reset    supprime la base et les secrets locaux (irréversible)
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
DIR="$ROOT/.dev"
S="$DIR/secrets"
DB=${FLAW_DB_CONTAINER:-flaw-dev-db}
VOLUME=${FLAW_DB_VOLUME:-flaw-dev-pgdata}
DB_PORT=${FLAW_DB_PORT:-55432}
IMAGE="postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873"

say() { printf '\033[1;34mFlaw\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31mFlaw\033[0m %s\n' "$*" >&2; exit 1; }

# Node 24 (engines) : celui de nvm s'il est installé, sinon celui du PATH.
NODE=$(ls -d "$HOME"/.nvm/versions/node/v24.*/bin/node 2>/dev/null | tail -1 || true)
NODE=${NODE:-node}

case "${1:-start}" in
  stop)
    docker stop "$DB" >/dev/null 2>&1 && say "base arrêtée." || say "base déjà arrêtée."
    exit 0
    ;;
  reset)
    printf 'Supprimer la base locale et ses secrets (tous les textes de ce poste) ? Tapez « oui » : ' >&2
    read -r answer
    [ "$answer" = "oui" ] || fail "annulé."
    docker rm -f "$DB" >/dev/null 2>&1 || true
    docker volume rm "$VOLUME" >/dev/null 2>&1 || true
    rm -rf "$S"
    say "base et secrets locaux supprimés."
    exit 0
    ;;
  start) ;;
  *) fail "commande inconnue : $1 (start, stop, reset)" ;;
esac

# --- Prérequis ---
command -v docker >/dev/null 2>&1 || fail "Docker est requis (https://docs.docker.com/get-docker/)."
docker info >/dev/null 2>&1 || fail "Docker ne répond pas : lancez Docker Desktop puis recommencez."
command -v openssl >/dev/null 2>&1 || fail "openssl est requis."
major=$("$NODE" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
[ "$major" = "24" ] || fail "Node.js 24 est requis (trouvé : $major). Avec nvm : nvm install 24."
[ -d "$ROOT/node_modules" ] || fail "dépendances absentes : lancez d'abord « corepack pnpm install »."

# --- Secrets (une fois, jamais commités) ---
. "$ROOT/infra/initdb/secret-valide.inc"
gen() {
  kind=$1
  n=0
  while [ "$n" -lt 200 ]; do
    n=$((n + 1))
    case "$kind" in
      hex32) candidate=$(openssl rand -hex 32) ;;
      b64_48) candidate=$(openssl rand -base64 48 | tr -d '\n') ;;
      kek) candidate=$(openssl rand -base64 32) ;;
    esac
    secret_valide "$candidate" || continue
    if [ "$kind" = "kek" ]; then
      size=$(printf '%s' "$candidate" | openssl base64 -d -A 2>/dev/null | wc -c | tr -d ' ')
      [ "$size" = "32" ] || continue
    fi
    printf '%s' "$candidate"
    return 0
  done
  fail "aucun secret valide généré."
}
umask 077
mkdir -p "$S"
for spec in postgres_password:hex32 app_db_password:hex32 db_owner_password:hex32 better_auth_secret:b64_48 flaw_kek:kek recovery_pepper:kek hmac_pepper:kek; do
  name=${spec%%:*}
  [ -s "$S/$name" ] || { gen "${spec#*:}" > "$S/$name"; say "secret créé : $name"; }
done

# --- Base PostgreSQL ---
if ! docker inspect "$DB" >/dev/null 2>&1; then
  say "création de la base ($DB, 127.0.0.1:$DB_PORT)…"
  docker run -d --name "$DB" \
    -p "127.0.0.1:$DB_PORT:5432" \
    -v "$VOLUME:/var/lib/postgresql" \
    -v "$ROOT/infra/initdb:/docker-entrypoint-initdb.d:ro" \
    -v "$S:/secrets-src:ro" \
    -e POSTGRES_DB=flaw -e POSTGRES_USER=postgres \
    -e POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password \
    -e POSTGRES_INITDB_ARGS="--auth-host=scram-sha-256 --data-checksums" \
    --entrypoint sh "$IMAGE" \
    -c 'mkdir -p /run/secrets && cp /secrets-src/* /run/secrets/ && chown 70:70 /run/secrets/* && chmod 440 /run/secrets/* && exec docker-entrypoint.sh postgres' \
    >/dev/null
elif [ "$(docker inspect -f '{{.State.Running}}' "$DB")" != "true" ]; then
  say "démarrage de la base…"
  docker start "$DB" >/dev/null
fi
n=0
until docker exec "$DB" pg_isready -q -h 127.0.0.1 -U postgres -d flaw 2>/dev/null; do
  n=$((n + 1))
  [ "$n" -lt 60 ] || fail "la base ne répond pas (docker logs $DB)."
  sleep 1
done

# --- Migrations, puis compte local (la connexion étant désactivée, il sert de propriétaire) ---
cd "$ROOT"
[ -f packages/crypto/dist/index.js ] || "$NODE" node_modules/typescript/bin/tsc -p packages/crypto/tsconfig.build.json
DATABASE_HOST=127.0.0.1 DATABASE_PORT=$DB_PORT DATABASE_NAME=flaw DATABASE_USER=flaw_owner \
  DATABASE_PASSWORD_FILE="$S/db_owner_password" "$NODE" apps/server/src/db/migrate.ts
users=$(docker exec "$DB" psql -U postgres -d flaw -tAc "SELECT count(*) FROM flaw.users" 2>/dev/null || echo 0)
if [ "$users" = "0" ]; then
  sh scripts/dev-admin.sh create-user --email moi@flaw.local >/dev/null 2>&1 && say "compte local créé."
fi

# --- Serveur (arrière-plan) et interface (premier plan) ---
mkdir -p "$DIR"
sh scripts/dev-server.sh >"$DIR/api.log" 2>&1 &
API=$!
trap 'kill "$API" 2>/dev/null || true' EXIT INT TERM
n=0
until curl -fsS http://127.0.0.1:3000/api/v1/healthz >/dev/null 2>&1; do
  n=$((n + 1))
  kill -0 "$API" 2>/dev/null || fail "le serveur s'est arrêté (voir .dev/api.log)."
  [ "$n" -lt 60 ] || fail "le serveur ne répond pas (voir .dev/api.log)."
  sleep 1
done
say "prêt : http://localhost:5173 (Ctrl+C pour arrêter ; la base reste disponible)."
cd apps/web
"$NODE" ../../node_modules/vite/bin/vite.js --port 5173 --strictPort
