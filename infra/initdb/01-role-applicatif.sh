#!/bin/sh
# Exécuté une fois par l'image postgres à l'initialisation du volume.
# Rôle flaw_app : ni superutilisateur, ni CREATEROLE, ni CREATEDB (SEC-DB-02).
# NOREPLICATION et NOBYPASSRLS : ajouts acceptés par l'Architecte.
# Le mot de passe suit secret-valide.inc (identique à creer-secrets.sh et healthz.ts).
set -eu
_here=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
. "$_here/secret-valide.inc"
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

raw=$(cat "$f"; printf x)
raw=${raw%x}
secret_valide "$raw" || { echo "refus de démarrer : secret invalide" >&2; exit 1; }
APP_PW=$(secret_normalise "$raw")

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_pw="$APP_PW" -v dbname="$POSTGRES_DB" <<'SQL'
CREATE ROLE flaw_app LOGIN PASSWORD :'app_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA IF NOT EXISTS flaw AUTHORIZATION flaw_app;
ALTER ROLE flaw_app SET search_path = flaw;
GRANT CONNECT ON DATABASE :"dbname" TO flaw_app;
-- drizzle-orm migrate() exécute CREATE SCHEMA IF NOT EXISTS même si flaw existe.
-- PostgreSQL 18 exige alors CREATE sur la base. Sans ce droit, flaw_app ne peut
-- pas enregistrer le journal de migrations. Rôle DDL distinct : avant public.
GRANT CREATE ON DATABASE :"dbname" TO flaw_app;
SQL
