#!/bin/sh
# Exécuté une fois par l'image postgres à l'initialisation du volume.
# flaw_app : DML seul, ni superutilisateur, ni CREATEROLE, ni CREATEDB (SEC-DB-02).
# flaw_owner : propriétaire du schéma et des tables. Migrations (arbitrage T-002 #5 annulé).
# NOREPLICATION et NOBYPASSRLS. NOINHERIT conservé pour flaw_app.
# Les mots de passe suivent secret-valide.inc (identique à creer-secrets.sh et healthz.ts).
set -eu
_here=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
. "$_here/secret-valide.inc"

read_secret() {
  f=$1
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
  raw=$(cat "$f"; printf x)
  raw=${raw%x}
  secret_valide "$raw" || { echo "refus de démarrer : secret invalide" >&2; exit 1; }
  secret_normalise "$raw"
}

APP_PW=$(read_secret /run/secrets/app_db_password)
OWNER_PW=$(read_secret /run/secrets/db_owner_password)

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_pw="$APP_PW" -v owner_pw="$OWNER_PW" -v dbname="$POSTGRES_DB" <<'SQL'
CREATE ROLE flaw_app LOGIN PASSWORD :'app_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE flaw_owner LOGIN PASSWORD :'owner_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA IF NOT EXISTS flaw AUTHORIZATION flaw_owner;
ALTER ROLE flaw_app SET search_path = flaw;
ALTER ROLE flaw_owner SET search_path = flaw;
GRANT CONNECT, CREATE ON DATABASE :"dbname" TO flaw_owner;
REVOKE CREATE ON DATABASE :"dbname" FROM flaw_app;
GRANT CONNECT ON DATABASE :"dbname" TO flaw_app;
REVOKE ALL ON SCHEMA flaw FROM PUBLIC;
GRANT USAGE ON SCHEMA flaw TO flaw_app;
ALTER DEFAULT PRIVILEGES FOR ROLE flaw_owner IN SCHEMA flaw GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO flaw_app;
ALTER DEFAULT PRIVILEGES FOR ROLE flaw_owner IN SCHEMA flaw GRANT USAGE, SELECT ON SEQUENCES TO flaw_app;
SQL
