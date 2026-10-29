#!/bin/sh
# Sauvegarde de la base de développement (conteneur flaw-dev-db) dans .dev/backups.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
mkdir -p "$ROOT/.dev/backups"
docker cp "$ROOT/infra/backup/backup.sh" flaw-dev-db:/tmp/backup.sh
docker exec -e BACKUP_DIR=/tmp/flaw-backups -e PGUSER=postgres -e PGPASSWORD_FILE=/run/secrets/postgres_password -e PGHOST=127.0.0.1 flaw-dev-db sh /tmp/backup.sh
docker cp flaw-dev-db:/tmp/flaw-backups/. "$ROOT/.dev/backups/"
ls -1t "$ROOT/.dev/backups" | head -3
