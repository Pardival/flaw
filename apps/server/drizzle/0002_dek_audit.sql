-- T-006. Additive. 0000_init n'est pas réécrit. Aucune colonne n'est renommée.
-- Conversion text → uuid (USING key_id::uuid) exécutée ci-dessous sur les
-- colonnes de contenu : auth_factors, documents, document_states,
-- document_updates, document_versions.
-- user_keys.key_id reste l'identifiant de la KEK (text, ex. kek-2026-10).
-- Il n'est pas converti.
-- Sans objet pour les données en v1 : rien n'est déployé.
-- Elle échouerait sur une base dont les key_id de contenu seraient des
-- identifiants de KEK, qui ne sont pas des uuid.
-- Le key_id des contenus désigne la DEK : FK (key_id, owner_id) vers user_keys.
-- audit_events.result reste un code en clair.
ALTER TABLE flaw.user_keys ADD CONSTRAINT user_keys_id_owner_uidx UNIQUE (id, owner_id);
--> statement-breakpoint
ALTER TABLE flaw.auth_factors ALTER COLUMN key_id TYPE uuid USING key_id::uuid;
--> statement-breakpoint
ALTER TABLE flaw.auth_factors ADD CONSTRAINT auth_factors_dek_owner_fk FOREIGN KEY (key_id, owner_id) REFERENCES flaw.user_keys (id, owner_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE flaw.documents ALTER COLUMN key_id TYPE uuid USING key_id::uuid;
--> statement-breakpoint
ALTER TABLE flaw.documents ADD CONSTRAINT documents_dek_owner_fk FOREIGN KEY (key_id, owner_id) REFERENCES flaw.user_keys (id, owner_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE flaw.document_states ALTER COLUMN key_id TYPE uuid USING key_id::uuid;
--> statement-breakpoint
ALTER TABLE flaw.document_states ADD CONSTRAINT document_states_dek_owner_fk FOREIGN KEY (key_id, owner_id) REFERENCES flaw.user_keys (id, owner_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE flaw.document_updates ALTER COLUMN key_id TYPE uuid USING key_id::uuid;
--> statement-breakpoint
ALTER TABLE flaw.document_updates ADD CONSTRAINT document_updates_dek_owner_fk FOREIGN KEY (key_id, owner_id) REFERENCES flaw.user_keys (id, owner_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE flaw.document_versions ALTER COLUMN key_id TYPE uuid USING key_id::uuid;
--> statement-breakpoint
ALTER TABLE flaw.document_versions ADD CONSTRAINT document_versions_dek_owner_fk FOREIGN KEY (key_id, owner_id) REFERENCES flaw.user_keys (id, owner_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE flaw.audit_events ADD CONSTRAINT audit_events_result_check CHECK (result IN ('ok', 'refus', 'erreur'));
