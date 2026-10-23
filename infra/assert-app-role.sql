-- Écarts du rôle flaw_app (T-005). 0 ligne = conforme.
-- G2 : flaw_owner, flaw_app et flaw_journal n'appartiennent à aucun rôle.
WITH expected AS (
  SELECT *
  FROM (VALUES
    ('users', false, false, true, true, true, true),
    ('accounts', false, false, true, true, true, true),
    ('sessions', false, false, true, true, true, true),
    ('verifications', false, false, true, true, true, true),
    ('auth_factors', false, false, true, true, true, true),
    ('recovery_codes', false, false, true, true, true, true),
    ('user_keys', false, false, true, true, true, true),
    ('keks', false, false, true, true, true, false),
    ('user_preferences', false, false, true, true, true, true),
    ('daily_progress', false, false, true, true, true, true),
    ('rate_limits', false, false, true, true, true, true),
    ('documents', true, true, true, true, true, true),
    ('document_states', true, true, true, true, true, true),
    ('document_updates', true, true, true, true, true, true),
    ('document_versions', true, true, true, true, true, true),
    ('audit_events', false, false, true, true, false, false),
    ('erasure_log', false, false, true, false, false, false),
    ('erasure_outbox', false, false, true, true, false, false),
    ('erasure_journal_head', false, false, true, true, false, false),
    ('auth_events', false, false, false, true, false, false)
  ) AS t(name, rls, forced, sel, ins, upd, del)
),
tables AS (
  SELECT c.relname AS name, c.oid, c.relrowsecurity, c.relforcerowsecurity, c.relowner, c.relkind
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'flaw' AND c.relkind = 'r'
)
SELECT 'table ' || t.name || ' absente de la liste' AS ecart
FROM tables t
WHERE NOT EXISTS (SELECT 1 FROM expected e WHERE e.name = t.name)
UNION ALL
SELECT 'table ' || e.name || ' absente'
FROM expected e
WHERE NOT EXISTS (SELECT 1 FROM tables t WHERE t.name = e.name)
UNION ALL
SELECT 'rls ' || e.name
FROM expected e
JOIN tables t ON t.name = e.name
WHERE t.relrowsecurity IS DISTINCT FROM e.rls
   OR t.relforcerowsecurity IS DISTINCT FROM e.forced
UNION ALL
SELECT 'privilege ' || e.name || ' ' || priv.nom
FROM expected e
JOIN tables t ON t.name = e.name
CROSS JOIN (VALUES ('SELECT', 'sel'), ('INSERT', 'ins'), ('UPDATE', 'upd'), ('DELETE', 'del')) AS priv(nom, col)
WHERE has_table_privilege('flaw_app', t.oid, priv.nom) IS DISTINCT FROM
  CASE priv.col
    WHEN 'sel' THEN e.sel
    WHEN 'ins' THEN e.ins
    WHEN 'upd' THEN e.upd
    ELSE e.del
  END
UNION ALL
SELECT 'truncate ' || t.name
FROM tables t
WHERE has_table_privilege('flaw_app', t.oid, 'TRUNCATE')
UNION ALL
SELECT 'proprietaire ' || n.nspname || '.' || c.relname
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('flaw', 'drizzle')
  AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f', 'i')
  AND pg_get_userbyid(c.relowner) <> 'flaw_owner'
UNION ALL
SELECT 'schema ' || nspname
FROM pg_namespace
WHERE nspname IN ('flaw', 'drizzle')
  AND pg_get_userbyid(nspowner) <> 'flaw_owner'
UNION ALL
SELECT 'g2 ' || membre.rolname || ' membre de ' || groupe.rolname
FROM pg_auth_members m
JOIN pg_roles membre ON membre.oid = m.member
JOIN pg_roles groupe ON groupe.oid = m.roleid
WHERE membre.rolname IN ('flaw_owner', 'flaw_app', 'flaw_journal')
UNION ALL
SELECT 'role ' || nom || ' absent'
FROM (VALUES ('flaw_owner'), ('flaw_app'), ('flaw_journal')) AS roles(nom)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = nom)
UNION ALL
SELECT 'attribut ' || rolname
FROM pg_roles
WHERE rolname IN ('flaw_owner', 'flaw_app', 'flaw_journal')
  AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication OR rolinherit)
UNION ALL
SELECT 'colonne ' || n.nspname || '.' || c.relname || '.' || a.attname
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('flaw', 'drizzle', 'public')
  AND a.attnum > 0
  AND NOT a.attisdropped
  AND a.attacl IS NOT NULL
UNION ALL
SELECT 'politique en trop ' || c.relname || ' ' || p.polname
FROM pg_policy p
JOIN pg_class c ON c.oid = p.polrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'flaw'
  AND c.relname NOT IN ('documents', 'document_states', 'document_updates', 'document_versions')
UNION ALL
SELECT 'politique ' || e.name
FROM expected e
WHERE e.rls
  AND NOT EXISTS (
    SELECT 1
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'flaw'
      AND c.relname = e.name
      AND p.polname = e.name || '_owner'
      AND p.polcmd = '*'
      AND pg_get_expr(p.polqual, p.polrelid) LIKE '%NULLIF%'
      AND pg_get_expr(p.polqual, p.polrelid) LIKE '%app.user_id%'
      AND pg_get_expr(p.polqual, p.polrelid) LIKE '%::uuid%'
      AND pg_get_expr(p.polwithcheck, p.polrelid) LIKE '%NULLIF%'
  )
UNION ALL
SELECT 'declencheur'
WHERE (
  SELECT count(*)
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'flaw'
    AND NOT t.tgisinternal
    AND t.tgname IN ('journaliser_effacement_users', 'journaliser_effacement_documents')
    AND t.tgenabled = 'O'
) <> 2
UNION ALL
SELECT 'purge_journaux'
WHERE NOT EXISTS (
  SELECT 1
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'flaw'
    AND p.proname = 'purge_journaux'
    AND p.prosecdef
    AND p.pronargs = 0
    AND p.proconfig @> ARRAY['search_path=pg_catalog, flaw, pg_temp']
    AND pg_get_userbyid(p.proowner) = 'flaw_owner'
    AND p.proacl IS NOT NULL
    AND has_function_privilege('flaw_app', p.oid, 'EXECUTE')
    AND NOT EXISTS (
      SELECT 1
      FROM aclexplode(p.proacl) AS x
      WHERE x.grantee = 0 AND x.privilege_type = 'EXECUTE'
    )
)
UNION ALL
SELECT 'check erasure_log'
WHERE (
  SELECT count(*)
  FROM pg_constraint
  WHERE conname IN ('erasure_log_owner_user', 'erasure_log_owner_document')
) <> 2
UNION ALL
SELECT 'defaut ' || coalesce(n.nspname, '*') || '/' || d.defaclobjtype::text
FROM pg_default_acl d
JOIN pg_roles r ON r.oid = d.defaclrole
LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
WHERE r.rolname = 'flaw_owner'
  AND NOT (
    n.nspname = 'flaw'
    AND d.defaclobjtype IN ('r', 'S')
    AND NOT EXISTS (
      SELECT 1
      FROM aclexplode(d.defaclacl) AS x
      WHERE x.grantee = 0
    )
  )
  AND NOT (
    d.defaclnamespace = 0
    AND d.defaclobjtype = 'f'
    AND NOT EXISTS (
      SELECT 1
      FROM aclexplode(d.defaclacl) AS x
      WHERE x.grantee = 0 AND x.privilege_type = 'EXECUTE'
    )
  )
UNION ALL
SELECT 'declencheur user_keys revoked'
WHERE NOT EXISTS (
  SELECT 1
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_proc p ON p.oid = t.tgfoid
  WHERE n.nspname = 'flaw'
    AND c.relname = 'user_keys'
    AND NOT t.tgisinternal
    AND p.proname = 'user_keys_keep_revoked'
    AND (t.tgtype & 4) <> 0
    AND (t.tgtype & 8) <> 0
    AND (t.tgtype & 16) <> 0
    AND (t.tgtype & 2) <> 0
);
