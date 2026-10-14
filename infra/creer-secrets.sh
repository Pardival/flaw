#!/bin/sh
# creer-secrets.sh — Flaw (modèle v0.4, dossier infra/).
# Crée secrets/ : propriétaire = UID du lecteur, 400 (440 si partage par le groupe 70).
# N'écrase jamais. Les secrets de sauvegarde hors site sont en T-042.
#
#   Secret              Lu par                     Propriétaire  Droits
#   postgres_password   db (UID 70)                70:70         400
#   app_db_password     app, migrate (10001), db   10001:70      440
#   better_auth_secret  app (10001)                10001:10001   400
#   flaw_kek            app (10001)                10001:10001   400
#   recovery_pepper     app (10001)                10001:10001   400
#
# Usage (depuis infra/) :
#   sudo sh creer-secrets.sh
#   sudo sh creer-secrets.sh --verifier
# SEC-SECRET-07 : retire uniquement le \r\n ou le \n final (aucun autre trim).
# Longueur et caractères distincts en octets UTF-8, comme healthz.ts.
# Le validateur est infra/initdb/secret-valide.inc (même fichier que l'init postgres).
set -eu
umask 077
_here=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
. "$_here/initdb/secret-valide.inc"
D="${SECRETS_DIR:-./secrets}"

SPEC='postgres_password 70:70 400 hex32
app_db_password 10001:70 440 hex32
better_auth_secret 10001:10001 400 b64_48
flaw_kek 10001:10001 400 kek
recovery_pepper 10001:10001 400 kek'

gen() {
  kind=$1
  n=0
  while [ "$n" -lt 200 ]; do
    n=$((n + 1))
    case "$kind" in
      hex32) candidate=$(openssl rand -hex 32) ;;
      b64_48) candidate=$(openssl rand -base64 48) ;;
      kek) candidate=$(openssl rand -base64 32) ;;
      *) echo "générateur inconnu" >&2; return 1 ;;
    esac
    secret_valide "$candidate" || continue
    if [ "$kind" = "kek" ]; then
      size=$(printf '%s' "$candidate" | base64 -d 2>/dev/null | wc -c | tr -d ' ')
      [ "$size" = "32" ] || continue
    fi
    printf '%s' "$candidate"
    return 0
  done
  echo "générateur : aucun secret valide" >&2
  return 1
}

if [ "${1:-}" = "--verifier" ]; then
  ok=0
  echo "$SPEC" | while read -r n own mode g; do
    f="$D/$n"
    [ -e "$f" ] || { echo "MANQUANT  $f"; exit 1; }
    cur="$(stat -c '%u:%g %a' "$f")"
    [ "$cur" = "$own $mode" ] || { echo "ÉCART     $f ($cur, attendu $own $mode)"; exit 1; }
    raw=$(cat "$f"; printf x)
    raw=${raw%x}
    secret_valide "$raw" || { echo "ÉCART     $f (contenu)"; exit 1; }
    echo "OK        $f ($cur)"
  done || ok=1
  m="$(stat -c '%a' "$D")"
  [ "$m" = "700" ] || { echo "ÉCART     $D ($m, attendu 700)"; ok=1; }
  downer="$(stat -c '%u:%g' "$D")"
  [ "$downer" = "0:0" ] || { echo "ÉCART     $D ($downer, attendu 0:0)"; ok=1; }
  for k in "$D/flaw_kek" "$D/recovery_pepper" "$D"/recovery_pepper_*; do
    [ -e "$k" ] || continue
    t="$(base64 -d "$k" 2>/dev/null | wc -c | tr -d ' ')"
    [ "$t" = "32" ] && echo "OK        $k (32 octets)" || { echo "ÉCART     $k ($t octets, attendu 32)"; ok=1; }
  done
  exit "$ok"
fi

[ "$(id -u)" -eq 0 ] || { echo "À lancer avec les droits root (chown vers les UID des conteneurs)." >&2; exit 1; }
mkdir -p "$D"
chown root:root "$D"
chmod 700 "$D"
echo "$SPEC" | while read -r n own mode g; do
  f="$D/$n"
  if [ -e "$f" ]; then
    echo "conservé  $f"
  else
    tmp=$(mktemp)
    gen "$g" > "$tmp"
    mv "$tmp" "$f"
    echo "créé      $f"
  fi
  chown "$own" "$f"
  chmod "$mode" "$f"
done
printf 'Empreinte flaw_kek : %s\n' "$(base64 -d "$D/flaw_kek" | sha256sum | cut -c1-16)"
printf 'Taille flaw_kek décodée : %s octets (attendu 32)\n' "$(base64 -d "$D/flaw_kek" | wc -c | tr -d ' ')"
printf 'Empreinte recovery_pepper : %s\n' "$(base64 -d "$D/recovery_pepper" | sha256sum | cut -c1-16)"
printf 'Taille recovery_pepper décodée : %s octets (attendu 32)\n' "$(base64 -d "$D/recovery_pepper" | wc -c | tr -d ' ')"
echo "À COPIER dans le gestionnaire : flaw_kek, recovery_pepper (+ empreintes, FLAW_KEK_ID, RECOVERY_PEPPER_ID)."
