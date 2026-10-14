#!/bin/sh
# SEC-DB-02 — rôle applicatif flaw_app, moindre privilège. Migrations hors de ce rôle.
set -eu

secret=/run/secrets/db_app_password
if [ ! -s "$secret" ]; then
  echo "refus de démarrer : secret du rôle flaw_app absent" >&2
  exit 1
fi

app_pw=$(tr -d '\r\n' < "$secret")
case "$app_pw" in
  postgres|password|admin|flaw|changeme|secret)
    echo "refus de démarrer : secret du rôle flaw_app invalide" >&2
    exit 1
    ;;
esac
if [ "${#app_pw}" -lt 32 ]; then
  echo "refus de démarrer : secret du rôle flaw_app invalide" >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 -v app_pw="$app_pw" -v dbname="$POSTGRES_DB" \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flaw_app') THEN
    CREATE ROLE flaw_app
      LOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOREPLICATION
      NOBYPASSRLS
      NOINHERIT;
  END IF;
END
$$;
ALTER ROLE flaw_app WITH
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOREPLICATION
  NOBYPASSRLS
  NOINHERIT
  PASSWORD :'app_pw';
REVOKE ALL ON DATABASE :"dbname" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"dbname" TO flaw_app;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO flaw_app;
SQL
