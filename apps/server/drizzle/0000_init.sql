-- T-005. Schéma flaw. flaw_owner est propriétaire. RLS forcée sur les 4 tables de contenu.
REVOKE ALL ON SCHEMA flaw FROM PUBLIC;
--> statement-breakpoint
CREATE TABLE flaw.users (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  role text NOT NULL DEFAULT 'user',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_role_check CHECK (role IN ('user', 'admin'))
);
--> statement-breakpoint
CREATE TABLE flaw.accounts (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  owner_id uuid NOT NULL REFERENCES flaw.users (id) ON DELETE CASCADE,
  provider_id text NOT NULL,
  account_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounts_provider_account_uidx UNIQUE (provider_id, account_id)
);
--> statement-breakpoint
CREATE TABLE flaw.sessions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  owner_id uuid NOT NULL REFERENCES flaw.users (id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sessions_token_hash_uidx UNIQUE (token_hash)
);
--> statement-breakpoint
CREATE TABLE flaw.verifications (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  identifier text NOT NULL,
  value_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT verifications_identifier_hmac CHECK (identifier ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE flaw.auth_factors (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  owner_id uuid NOT NULL REFERENCES flaw.users (id) ON DELETE CASCADE,
  kind text NOT NULL,
  secret_ct bytea NOT NULL,
  secret_nonce bytea NOT NULL,
  key_id text NOT NULL,
  enc_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE flaw.recovery_codes (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL REFERENCES flaw.users (id) ON DELETE CASCADE,
  pepper_id text NOT NULL,
  code_hmac bytea NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recovery_codes_user_code_hmac_uidx UNIQUE (user_id, code_hmac),
  CONSTRAINT recovery_codes_code_hmac_len CHECK (octet_length(code_hmac) = 32)
);
--> statement-breakpoint
CREATE TABLE flaw.user_keys (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  owner_id uuid NOT NULL REFERENCES flaw.users (id) ON DELETE CASCADE,
  wrapped_ct bytea NOT NULL,
  wrapped_nonce bytea NOT NULL,
  key_id text NOT NULL,
  enc_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE flaw.user_preferences (
  owner_id uuid PRIMARY KEY REFERENCES flaw.users (id) ON DELETE CASCADE,
  browser_spellcheck boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE flaw.daily_progress (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  owner_id uuid NOT NULL REFERENCES flaw.users (id) ON DELETE CASCADE,
  day date NOT NULL,
  progress_count integer NOT NULL DEFAULT 0,
  CONSTRAINT daily_progress_owner_day_uidx UNIQUE (owner_id, day)
);
--> statement-breakpoint
CREATE TABLE flaw.rate_limits (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  bucket text NOT NULL,
  window_start timestamptz NOT NULL,
  hits integer NOT NULL,
  CONSTRAINT rate_limits_bucket_window_uidx UNIQUE (bucket, window_start),
  CONSTRAINT rate_limits_bucket_hmac CHECK (bucket ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE flaw.erasure_log (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  subject text NOT NULL,
  subject_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  origine text NOT NULL DEFAULT 'effacement',
  erased_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT erasure_log_subject_check CHECK (subject IN ('user', 'document')),
  CONSTRAINT erasure_log_origine_check CHECK (origine IN ('effacement', 'rejeu')),
  CONSTRAINT erasure_log_owner_user CHECK (subject <> 'user' OR owner_id = subject_id),
  CONSTRAINT erasure_log_owner_document CHECK (subject <> 'document' OR owner_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE flaw.erasure_outbox (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  seq bigint,
  subject text NOT NULL,
  subject_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  entry_hash bytea,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT erasure_outbox_subject_check CHECK (subject IN ('user', 'document'))
);
--> statement-breakpoint
CREATE TABLE flaw.erasure_journal_head (
  seq bigint NOT NULL DEFAULT 0,
  singleton boolean NOT NULL DEFAULT true,
  CONSTRAINT erasure_journal_head_singleton_uidx UNIQUE (singleton),
  CONSTRAINT erasure_journal_head_singleton_check CHECK (singleton = true)
);
--> statement-breakpoint
INSERT INTO flaw.erasure_journal_head (seq) VALUES (0);
--> statement-breakpoint
CREATE TABLE flaw.audit_events (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  owner_id uuid NOT NULL,
  event_type text NOT NULL,
  result text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE flaw.auth_events (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  event_type text NOT NULL CHECK (event_type IN ('login_failed','login_rate_limited','mfa_failed')),
  subject_hmac text,
  ip_hmac text,
  user_agent_summary text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_events_subject_hmac_check CHECK (subject_hmac ~ '^[0-9a-f]{64}$'),
  CONSTRAINT auth_events_ip_hmac_check CHECK (ip_hmac ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE flaw.documents (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES flaw.users (id) ON DELETE CASCADE,
  mode text NOT NULL,
  format text NOT NULL,
  font text NOT NULL,
  counter integer NOT NULL DEFAULT 0,
  revision integer NOT NULL DEFAULT 0,
  projection_ct bytea NOT NULL,
  projection_nonce bytea NOT NULL,
  key_id text NOT NULL,
  enc_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT documents_id_owner_uidx UNIQUE (id, owner_id)
);
--> statement-breakpoint
CREATE TABLE flaw.document_states (
  document_id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES flaw.users (id) ON DELETE CASCADE,
  state_ct bytea NOT NULL,
  state_nonce bytea NOT NULL,
  key_id text NOT NULL,
  enc_version integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_states_document_owner_fk
    FOREIGN KEY (document_id, owner_id) REFERENCES flaw.documents (id, owner_id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE flaw.document_updates (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  document_id uuid NOT NULL,
  owner_id uuid NOT NULL REFERENCES flaw.users (id) ON DELETE CASCADE,
  update_ct bytea NOT NULL,
  update_nonce bytea NOT NULL,
  key_id text NOT NULL,
  enc_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_updates_document_owner_fk
    FOREIGN KEY (document_id, owner_id) REFERENCES flaw.documents (id, owner_id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE flaw.document_versions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  document_id uuid NOT NULL,
  owner_id uuid NOT NULL REFERENCES flaw.users (id) ON DELETE CASCADE,
  version_ct bytea NOT NULL,
  version_nonce bytea NOT NULL,
  key_id text NOT NULL,
  enc_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_versions_document_owner_fk
    FOREIGN KEY (document_id, owner_id) REFERENCES flaw.documents (id, owner_id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX accounts_owner_id_idx ON flaw.accounts (owner_id);
--> statement-breakpoint
CREATE INDEX sessions_owner_id_idx ON flaw.sessions (owner_id);
--> statement-breakpoint
CREATE INDEX verifications_identifier_idx ON flaw.verifications (identifier);
--> statement-breakpoint
CREATE INDEX auth_factors_owner_id_idx ON flaw.auth_factors (owner_id);
--> statement-breakpoint
CREATE INDEX user_keys_owner_id_idx ON flaw.user_keys (owner_id);
--> statement-breakpoint
CREATE INDEX erasure_log_owner_id_idx ON flaw.erasure_log (owner_id);
--> statement-breakpoint
CREATE INDEX erasure_outbox_owner_id_idx ON flaw.erasure_outbox (owner_id);
--> statement-breakpoint
CREATE INDEX erasure_outbox_published_at_idx ON flaw.erasure_outbox (published_at);
--> statement-breakpoint
CREATE INDEX audit_events_owner_id_idx ON flaw.audit_events (owner_id);
--> statement-breakpoint
CREATE INDEX documents_owner_id_idx ON flaw.documents (owner_id);
--> statement-breakpoint
CREATE INDEX document_states_owner_id_idx ON flaw.document_states (owner_id);
--> statement-breakpoint
CREATE INDEX document_updates_owner_id_idx ON flaw.document_updates (owner_id);
--> statement-breakpoint
CREATE INDEX document_updates_document_id_idx ON flaw.document_updates (document_id);
--> statement-breakpoint
CREATE INDEX document_versions_owner_id_idx ON flaw.document_versions (owner_id);
--> statement-breakpoint
CREATE INDEX document_versions_document_id_idx ON flaw.document_versions (document_id);
--> statement-breakpoint
COMMENT ON COLUMN flaw.verifications.identifier IS 'HMAC-SHA256 poivré (hex), jamais le jeton en clair';
--> statement-breakpoint
COMMENT ON COLUMN flaw.rate_limits.bucket IS 'HMAC-SHA256 poivré (hex), jamais le seau en clair';
--> statement-breakpoint
ALTER TABLE flaw.documents ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE flaw.documents FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY documents_owner ON flaw.documents
  FOR ALL TO flaw_app
  USING (owner_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (owner_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE flaw.document_states ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE flaw.document_states FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY document_states_owner ON flaw.document_states
  FOR ALL TO flaw_app
  USING (owner_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (owner_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE flaw.document_updates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE flaw.document_updates FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY document_updates_owner ON flaw.document_updates
  FOR ALL TO flaw_app
  USING (owner_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (owner_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE flaw.document_versions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE flaw.document_versions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY document_versions_owner ON flaw.document_versions
  FOR ALL TO flaw_app
  USING (owner_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (owner_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
CREATE FUNCTION flaw.journaliser_effacement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, flaw, pg_temp
AS $$
DECLARE
  origine text := 'effacement';
BEGIN
  IF session_user = 'flaw_owner' AND current_setting('flaw.rejeu', true) = 'on' THEN
    origine := 'rejeu';
  END IF;
  IF TG_TABLE_NAME = 'users' THEN
    INSERT INTO flaw.erasure_log (subject, subject_id, owner_id, origine)
    VALUES ('user', OLD.id, OLD.id, origine);
    IF origine = 'effacement' THEN
      INSERT INTO flaw.erasure_outbox (subject, subject_id, owner_id)
      VALUES ('user', OLD.id, OLD.id);
    END IF;
  ELSIF TG_TABLE_NAME = 'documents' THEN
    INSERT INTO flaw.erasure_log (subject, subject_id, owner_id, origine)
    VALUES ('document', OLD.id, OLD.owner_id, origine);
    IF origine = 'effacement' THEN
      INSERT INTO flaw.erasure_outbox (subject, subject_id, owner_id)
      VALUES ('document', OLD.id, OLD.owner_id);
    END IF;
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER journaliser_effacement_users
  AFTER DELETE ON flaw.users
  FOR EACH ROW EXECUTE FUNCTION flaw.journaliser_effacement();
--> statement-breakpoint
CREATE TRIGGER journaliser_effacement_documents
  AFTER DELETE ON flaw.documents
  FOR EACH ROW EXECUTE FUNCTION flaw.journaliser_effacement();
--> statement-breakpoint
CREATE FUNCTION flaw.purge_journaux()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, flaw, pg_temp
AS $$
  DELETE FROM flaw.auth_events WHERE created_at < now() - interval '6 months';
  DELETE FROM flaw.audit_events WHERE created_at < now() - interval '12 months';
  DELETE FROM flaw.erasure_log WHERE erased_at < now() - interval '440 days';
  DELETE FROM flaw.erasure_outbox WHERE published_at IS NOT NULL AND published_at < now() - interval '440 days';
  DELETE FROM flaw.verifications WHERE expires_at < now();
  DELETE FROM flaw.rate_limits AS older
  WHERE EXISTS (
    SELECT 1
    FROM flaw.rate_limits AS newer
    WHERE newer.bucket = older.bucket
      AND newer.window_start > older.window_start
  );
$$;
