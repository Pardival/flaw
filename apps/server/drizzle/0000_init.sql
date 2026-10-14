-- T-005. Schéma flaw, RLS forcée. flaw_app est propriétaire (migrate v1, arbitrage T-002 #5).
REVOKE ALL ON SCHEMA flaw FROM PUBLIC;
--> statement-breakpoint
CREATE TABLE flaw.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role text NOT NULL DEFAULT 'user',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_role_check CHECK (role IN ('user', 'admin'))
);
--> statement-breakpoint
CREATE TABLE flaw.accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES flaw.users (id) ON DELETE CASCADE,
  provider_id text NOT NULL,
  account_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounts_provider_account_uidx UNIQUE (provider_id, account_id)
);
--> statement-breakpoint
CREATE TABLE flaw.sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES flaw.users (id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sessions_token_hash_uidx UNIQUE (token_hash)
);
--> statement-breakpoint
CREATE TABLE flaw.verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier text NOT NULL,
  value_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE flaw.auth_factors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES flaw.users (id) ON DELETE CASCADE,
  kind text NOT NULL,
  secret_ciphertext bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE flaw.recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES flaw.users (id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE flaw.user_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES flaw.users (id) ON DELETE CASCADE,
  kek_id text NOT NULL,
  wrapped_key bytea NOT NULL,
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
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES flaw.users (id) ON DELETE CASCADE,
  day date NOT NULL,
  progress_count integer NOT NULL DEFAULT 0,
  CONSTRAINT daily_progress_owner_day_uidx UNIQUE (owner_id, day)
);
--> statement-breakpoint
CREATE TABLE flaw.rate_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket text NOT NULL,
  window_start timestamptz NOT NULL,
  hits integer NOT NULL,
  CONSTRAINT rate_limits_bucket_window_uidx UNIQUE (bucket, window_start)
);
--> statement-breakpoint
CREATE TABLE flaw.erasure_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  erased_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE flaw.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  event_type text NOT NULL,
  result text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE flaw.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES flaw.users (id) ON DELETE CASCADE,
  mode text NOT NULL,
  format text NOT NULL,
  font text NOT NULL,
  counter integer NOT NULL DEFAULT 0,
  revision integer NOT NULL DEFAULT 0,
  projection bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE flaw.document_states (
  document_id uuid PRIMARY KEY REFERENCES flaw.documents (id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES flaw.users (id) ON DELETE CASCADE,
  ciphertext bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE flaw.document_updates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES flaw.documents (id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES flaw.users (id) ON DELETE CASCADE,
  ciphertext bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE flaw.document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES flaw.documents (id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES flaw.users (id) ON DELETE CASCADE,
  ciphertext bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
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
CREATE INDEX recovery_codes_owner_id_idx ON flaw.recovery_codes (owner_id);
--> statement-breakpoint
CREATE INDEX user_keys_owner_id_idx ON flaw.user_keys (owner_id);
--> statement-breakpoint
CREATE INDEX erasure_log_owner_id_idx ON flaw.erasure_log (owner_id);
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
ALTER TABLE flaw.users ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE flaw.users FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY users_self ON flaw.users
  FOR ALL TO flaw_app
  USING (id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE flaw.accounts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE flaw.accounts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY accounts_owner ON flaw.accounts
  FOR ALL TO flaw_app
  USING (owner_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (owner_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE flaw.sessions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE flaw.sessions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY sessions_owner ON flaw.sessions
  FOR ALL TO flaw_app
  USING (owner_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (owner_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE flaw.auth_factors ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE flaw.auth_factors FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY auth_factors_owner ON flaw.auth_factors
  FOR ALL TO flaw_app
  USING (owner_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (owner_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE flaw.recovery_codes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE flaw.recovery_codes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY recovery_codes_owner ON flaw.recovery_codes
  FOR ALL TO flaw_app
  USING (owner_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (owner_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE flaw.user_keys ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE flaw.user_keys FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY user_keys_owner ON flaw.user_keys
  FOR ALL TO flaw_app
  USING (owner_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (owner_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE flaw.user_preferences ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE flaw.user_preferences FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY user_preferences_owner ON flaw.user_preferences
  FOR ALL TO flaw_app
  USING (owner_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (owner_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE flaw.daily_progress ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE flaw.daily_progress FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY daily_progress_owner ON flaw.daily_progress
  FOR ALL TO flaw_app
  USING (owner_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (owner_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE flaw.erasure_log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE flaw.erasure_log FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY erasure_log_owner ON flaw.erasure_log
  FOR ALL TO flaw_app
  USING (owner_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (owner_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE flaw.audit_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE flaw.audit_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY audit_events_owner ON flaw.audit_events
  FOR ALL TO flaw_app
  USING (owner_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (owner_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
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
