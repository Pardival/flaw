-- T-006. Additive. Aucune colonne T-005 n'est renommée.
-- user_keys.key_id reste l'identifiant de la KEK.
-- L'utilisateur est owner_id (schéma T-005), une seule DEK active par owner_id.
ALTER TABLE flaw.user_keys ADD COLUMN status text NOT NULL DEFAULT 'active';
--> statement-breakpoint
ALTER TABLE flaw.user_keys ADD CONSTRAINT user_keys_status_check CHECK (status IN ('active', 'retired'));
--> statement-breakpoint
CREATE UNIQUE INDEX user_keys_one_active_uidx ON flaw.user_keys (owner_id) WHERE status = 'active';
--> statement-breakpoint
ALTER TABLE flaw.document_versions ADD COLUMN label_ct bytea;
--> statement-breakpoint
ALTER TABLE flaw.document_versions ADD COLUMN label_nonce bytea;
--> statement-breakpoint
ALTER TABLE flaw.document_versions ADD CONSTRAINT document_versions_label_pair_check CHECK ((label_ct IS NULL) = (label_nonce IS NULL));
