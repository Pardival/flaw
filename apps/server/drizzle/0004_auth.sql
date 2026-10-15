-- T-007. Colonnes d'authentification. Ne modifie pas 0000_init.sql.
-- token_hash : SHA-256 brut (32 octets), jamais le jeton de session.
-- password_hash : chaîne PHC argon2id uniquement.
ALTER TABLE flaw.sessions
  ALTER COLUMN token_hash TYPE bytea USING decode(token_hash, 'hex'),
  ADD COLUMN last_activity_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN absolute_expires_at timestamptz NOT NULL DEFAULT (now() + interval '90 days'),
  ADD COLUMN revoked_at timestamptz,
  ADD COLUMN browser text NOT NULL DEFAULT 'inconnu',
  ADD COLUMN os text NOT NULL DEFAULT 'inconnu',
  ADD COLUMN remember boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE flaw.sessions
  ADD CONSTRAINT sessions_token_hash_len CHECK (octet_length(token_hash) = 32);
--> statement-breakpoint
ALTER TABLE flaw.accounts
  ADD COLUMN password_hash text,
  ADD CONSTRAINT accounts_password_argon2id CHECK (
    password_hash IS NULL OR password_hash LIKE '$argon2id$v=19$m=%'
  );
