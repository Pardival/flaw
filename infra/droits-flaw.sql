-- État connu des droits (T-005, rév. 10). Rejoué par migrate en flaw_owner, une transaction.
-- Une table de flaw absente de la liste, ou un objet de flaw/drizzle qui
-- n'appartient pas à flaw_owner, interrompt le script (G4).
BEGIN;

DO $$
DECLARE
  bad text;
  expected text[] := ARRAY[
    'users', 'accounts', 'sessions', 'verifications', 'auth_factors',
    'recovery_codes', 'user_keys', 'keks', 'user_preferences', 'daily_progress',
    'rate_limits', 'erasure_log', 'erasure_outbox', 'erasure_journal_head',
    'audit_events', 'auth_events',
    'documents', 'document_states', 'document_updates', 'document_versions'
  ];
BEGIN
  SELECT string_agg(n.nspname || '.' || c.relname, ', ' ORDER BY n.nspname, c.relname)
    INTO bad
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('flaw', 'drizzle')
    AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f', 'i')
    AND pg_get_userbyid(c.relowner) <> 'flaw_owner';
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'objet hors flaw_owner: %', bad;
  END IF;

  SELECT string_agg(n.nspname || '.' || p.proname, ', ' ORDER BY p.proname)
    INTO bad
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname IN ('flaw', 'drizzle')
    AND pg_get_userbyid(p.proowner) <> 'flaw_owner';
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'routine hors flaw_owner: %', bad;
  END IF;

  SELECT string_agg(n.nspname || '.' || t.typname, ', ' ORDER BY t.typname)
    INTO bad
  FROM pg_type t
  JOIN pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname IN ('flaw', 'drizzle')
    AND pg_get_userbyid(t.typowner) <> 'flaw_owner';
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'type hors flaw_owner: %', bad;
  END IF;

  SELECT string_agg(nspname, ', ')
    INTO bad
  FROM pg_namespace
  WHERE nspname IN ('flaw', 'drizzle')
    AND pg_get_userbyid(nspowner) <> 'flaw_owner';
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'schema hors flaw_owner: %', bad;
  END IF;

  SELECT string_agg(c.relname, ', ' ORDER BY c.relname)
    INTO bad
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'flaw' AND c.relkind = 'r'
    AND c.relname <> ALL (expected);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'table inconnue: %', bad;
  END IF;

  SELECT string_agg(nom, ', ')
    INTO bad
  FROM unnest(expected) AS nom
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'flaw' AND c.relkind = 'r' AND c.relname = nom
  );
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'table absente: %', bad;
  END IF;
END $$;

REVOKE ALL ON SCHEMA flaw FROM PUBLIC;
REVOKE ALL ON SCHEMA drizzle FROM PUBLIC;
REVOKE ALL ON SCHEMA flaw FROM flaw_app;
REVOKE ALL ON SCHEMA drizzle FROM flaw_app;
GRANT USAGE ON SCHEMA flaw TO flaw_app;

REVOKE ALL ON ALL TABLES IN SCHEMA flaw FROM PUBLIC, flaw_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA flaw FROM PUBLIC, flaw_app;
REVOKE ALL ON ALL ROUTINES IN SCHEMA flaw FROM PUBLIC, flaw_app;
REVOKE ALL ON ALL TABLES IN SCHEMA drizzle FROM PUBLIC, flaw_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA drizzle FROM PUBLIC, flaw_app;
REVOKE ALL ON ALL ROUTINES IN SCHEMA drizzle FROM PUBLIC, flaw_app;

DO $$
DECLARE
  col record;
BEGIN
  FOR col IN
    SELECT n.nspname AS schema_name, c.relname AS table_name, a.attname AS column_name
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('flaw', 'drizzle')
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND a.attacl IS NOT NULL
      AND c.relkind = 'r'
  LOOP
    EXECUTE format(
      'REVOKE ALL (%I) ON TABLE %I.%I FROM PUBLIC, flaw_app',
      col.column_name, col.schema_name, col.table_name
    );
  END LOOP;
END $$;

ALTER DEFAULT PRIVILEGES FOR ROLE flaw_owner IN SCHEMA flaw REVOKE ALL ON TABLES FROM PUBLIC, flaw_app;
ALTER DEFAULT PRIVILEGES FOR ROLE flaw_owner IN SCHEMA flaw REVOKE ALL ON SEQUENCES FROM PUBLIC, flaw_app;
ALTER DEFAULT PRIVILEGES FOR ROLE flaw_owner IN SCHEMA flaw REVOKE ALL ON ROUTINES FROM PUBLIC, flaw_app;
ALTER DEFAULT PRIVILEGES FOR ROLE flaw_owner IN SCHEMA drizzle REVOKE ALL ON TABLES FROM PUBLIC, flaw_app;
ALTER DEFAULT PRIVILEGES FOR ROLE flaw_owner IN SCHEMA drizzle REVOKE ALL ON SEQUENCES FROM PUBLIC, flaw_app;
ALTER DEFAULT PRIVILEGES FOR ROLE flaw_owner IN SCHEMA drizzle REVOKE ALL ON ROUTINES FROM PUBLIC, flaw_app;
ALTER DEFAULT PRIVILEGES FOR ROLE flaw_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  flaw.users,
  flaw.accounts,
  flaw.sessions,
  flaw.verifications,
  flaw.auth_factors,
  flaw.recovery_codes,
  flaw.user_preferences,
  flaw.daily_progress,
  flaw.rate_limits,
  flaw.documents,
  flaw.document_states,
  flaw.document_updates,
  flaw.document_versions
TO flaw_app;
GRANT SELECT, INSERT ON TABLE flaw.audit_events TO flaw_app;
GRANT SELECT ON TABLE flaw.erasure_log TO flaw_app;
GRANT SELECT, INSERT ON TABLE flaw.erasure_outbox, flaw.erasure_journal_head TO flaw_app;
GRANT INSERT ON TABLE flaw.auth_events TO flaw_app;
GRANT SELECT, INSERT, UPDATE ON TABLE flaw.keks TO flaw_app;
GRANT SELECT, INSERT, UPDATE ON TABLE flaw.user_keys TO flaw_app;
REVOKE DELETE ON TABLE flaw.user_keys FROM flaw_app;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA flaw TO flaw_app;
GRANT EXECUTE ON FUNCTION flaw.purge_journaux() TO flaw_app;
GRANT EXECUTE ON FUNCTION flaw.user_keys_keep_revoked() TO flaw_app;

ALTER DEFAULT PRIVILEGES FOR ROLE flaw_owner IN SCHEMA flaw
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO flaw_app;
ALTER DEFAULT PRIVILEGES FOR ROLE flaw_owner IN SCHEMA flaw
  GRANT USAGE, SELECT ON SEQUENCES TO flaw_app;

COMMIT;
