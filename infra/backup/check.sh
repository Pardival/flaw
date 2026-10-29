#!/bin/sh
# check.sh — surveillance (G4) : un dump valide de moins de 7 h et aucun marqueur d'échec,
# sinon code 1 (et alerte si ALERT_WEBHOOK_URL est en https).
set -eu
DIR="${BACKUP_DIR:-/backups}"
problem=""
if ls "$DIR"/ECHEC-* > /dev/null 2>&1; then
  problem="marqueur d'échec présent"
elif [ -z "$(find "$DIR" -maxdepth 1 -name 'flaw-*.dump' -mmin -420 2>/dev/null | head -1)" ]; then
  problem="aucun dump valide de moins de 7 h"
fi
if [ -n "$problem" ]; then
  echo "sauvegarde : $problem" >&2
  case "${ALERT_WEBHOOK_URL:-}" in
    https://*) wget -q -O /dev/null --header 'content-type: text/plain' --post-data "Flaw : sauvegarde — $problem" "$ALERT_WEBHOOK_URL" || true ;;
  esac
  exit 1
fi
echo "sauvegarde : ok"
