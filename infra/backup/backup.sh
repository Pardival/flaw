#!/bin/sh
# backup.sh — Flaw (T-042, G4, SEC-BKP-07).
# Dump PostgreSQL au format personnalisé, accepté seulement si pg_dump réussit ET si
# pg_restore --list le relit ; sinon fichier *.corrompu + marqueur ECHEC-… + code 1.
# Données exclues (structure gardée) : sessions, verifications, rate_limits.
# Rétention locale 14 jours. umask 027 (640). Aucun contenu en clair : les textes
# restent chiffrés par la KEK, qui n'est jamais dans le dump.
#
# Variables : PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD_FILE, BACKUP_DIR.
set -eu
umask 027
DIR="${BACKUP_DIR:-/backups}"
DB="${PGDATABASE:-flaw}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
mkdir -p "$DIR"
if [ -n "${PGPASSWORD_FILE:-}" ]; then
  PGPASSWORD=$(cat "$PGPASSWORD_FILE")
  export PGPASSWORD
fi
stamp=$(date -u +%Y%m%dT%H%M%SZ)
tmp="$DIR/.flaw-$stamp.dump.partiel"
final="$DIR/flaw-$stamp.dump"

fail() {
  [ -f "$tmp" ] && mv "$tmp" "$DIR/flaw-$stamp.dump.corrompu"
  : > "$DIR/ECHEC-$stamp"
  echo "sauvegarde en échec : $1" >&2
  exit 1
}

pg_dump --format=custom --compress=6 --no-owner \
  --exclude-table-data=flaw.sessions \
  --exclude-table-data=flaw.verifications \
  --exclude-table-data=flaw.rate_limits \
  --file="$tmp" "$DB" || fail "pg_dump"
pg_restore --list "$tmp" > /dev/null 2>&1 || fail "pg_restore --list"
[ -s "$tmp" ] || fail "dump vide"
mv "$tmp" "$final"
# Un succès efface les anciens marqueurs d'échec : la surveillance repart au vert.
rm -f "$DIR"/ECHEC-*
find "$DIR" -maxdepth 1 -name 'flaw-*.dump*' -mtime +"$KEEP_DAYS" -exec rm -f {} +
echo "sauvegarde valide : $(basename "$final") ($(wc -c < "$final" | tr -d ' ') octets)"
