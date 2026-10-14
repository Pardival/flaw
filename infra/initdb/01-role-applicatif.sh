#!/bin/sh
# Exécuté une fois par l'image postgres à l'initialisation du volume.
# Rôle flaw_app : ni superutilisateur, ni CREATEROLE, ni CREATEDB (SEC-DB-02).
# NOREPLICATION et NOBYPASSRLS : ajouts acceptés par l'Architecte.
# Le mot de passe suit le validateur de l'Expert (identique à healthz.ts).
set -eu
f=/run/secrets/app_db_password
if [ ! -e "$f" ]; then
  echo "refus de démarrer : secret absent" >&2
  exit 1
fi
if [ ! -r "$f" ]; then
  echo "refus de démarrer : EACCES" >&2
  exit 1
fi
mode=$(stat -c '%a' "$f" | tr -d ' ')
other=$(printf '%s' "$mode" | awk '{ print substr($0, length($0), 1) }')
case "$other" in
  0) ;;
  *) echo "refus de démarrer : secret lisible par tous" >&2; exit 1 ;;
esac

secret_valide() {
  raw=$(printf '%s' "$1" | tr -d '\r\n')
  len=$(printf '%s' "$raw" | wc -c | tr -d ' ')
  [ "$len" -ge 32 ] || return 1
  distinct=$(printf '%s' "$raw" | fold -w1 | sort -u | wc -l | tr -d ' ')
  [ "$distinct" -ge 16 ] || return 1
  low=$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')
  for word in change example exemple password motdepasse secret default todo xxx test dummy sample flaw postgres admin restic; do
    case "$low" in
      *"$word"*) return 1 ;;
    esac
  done
  return 0
}

APP_PW=$(tr -d '\r\n' < "$f")
secret_valide "$APP_PW" || { echo "refus de démarrer : secret invalide" >&2; exit 1; }

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_pw="$APP_PW" -v dbname="$POSTGRES_DB" <<'SQL'
CREATE ROLE flaw_app LOGIN PASSWORD :'app_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA IF NOT EXISTS flaw AUTHORIZATION flaw_app;
ALTER ROLE flaw_app SET search_path = flaw;
GRANT CONNECT ON DATABASE :"dbname" TO flaw_app;
SQL
