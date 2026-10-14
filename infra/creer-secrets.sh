#!/bin/sh
# A-020 / SEC-SECRET-06 / SEC-SECRET-07 — fichiers de secrets, sans valeur par défaut.
# Propriétaire = UID du lecteur, mode 400 (un lecteur) ou 440 (lecteurs d'un même groupe).
# .env ne contient que FLAW_DOMAIN et reste en mode 600.
set -eu

if [ "$(id -u)" -ne 0 ]; then
  exec sudo -E -- "$0" "$@"
fi

ROOT=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
SECRETS="$ROOT/secrets"
RUN="$ROOT/run"
ENV_FILE="$ROOT/.env"

if [ -z "${FLAW_DOMAIN:-}" ]; then
  echo "refus : FLAW_DOMAIN est requis (seule variable de domaine)." >&2
  exit 1
fi

case "$FLAW_DOMAIN" in
  *[!A-Za-z0-9.-]*|.*|*.|.|-*|*-)
    echo "refus : FLAW_DOMAIN invalide." >&2
    exit 1
    ;;
esac

umask 077
mkdir -p "$SECRETS" "$RUN/backups" "$RUN/restic"
chmod 700 "$SECRETS"

write_secret() {
  file=$1
  owner=$2
  mode=$3
  if [ ! -s "$file" ]; then
    openssl rand -base64 48 | tr -d '\n' > "$file"
  fi
  chown "$owner" "$file"
  chmod "$mode" "$file"
}

write_secret "$SECRETS/db_superuser_password" "70:70" 400
write_secret "$SECRETS/db_app_password" "10001:10001" 440
write_secret "$SECRETS/restic_password" "10003:10003" 400

repo_file="$SECRETS/restic_repository"
if [ ! -s "$repo_file" ]; then
  if [ -n "${FLAW_RESTIC_REPOSITORY:-}" ]; then
    printf '%s' "$FLAW_RESTIC_REPOSITORY" > "$repo_file"
  else
    printf '%s' "/repo" > "$repo_file"
    echo "avertissement : dépôt restic /repo (volume local). L'URL hors site n'est pas dans le paquet T-002." >&2
  fi
fi
chown "10003:10003" "$repo_file"
chmod 400 "$repo_file"

chown "70:10003" "$RUN/backups"
chmod 2750 "$RUN/backups"
chown "10003:10003" "$RUN/restic"
chmod 700 "$RUN/restic"

tmp=$(mktemp)
printf 'FLAW_DOMAIN=%s\n' "$FLAW_DOMAIN" > "$tmp"
if [ -n "${SUDO_UID:-}" ]; then
  chown "${SUDO_UID}:${SUDO_GID:-$SUDO_UID}" "$tmp"
fi
chmod 600 "$tmp"
mv "$tmp" "$ENV_FILE"

echo "secrets prêts (valeurs non affichées) : db_superuser_password, db_app_password, restic_password, restic_repository"
echo ".env en 600 : $ENV_FILE"
