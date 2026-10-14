-- T-006. Additive. Les cinq FK vers user_keys passent de ON DELETE CASCADE
-- (0002_dek_audit.sql) à ON DELETE NO ACTION. NO ACTION, et non RESTRICT :
-- le contrôle a lieu à la fin de l'ordre, donc DELETE du compte
-- (cascade users → contenus et user_keys) reste possible.
-- Supprimer une DEK encore référencée échoue (23503).
-- status, l'index partiel d'une seule DEK active, et le couple
-- label_ct / label_nonce sont déjà dans 0001_enveloppe.sql.
-- Aucune RLS sur user_keys (reportée à T-050).
ALTER TABLE flaw.auth_factors DROP CONSTRAINT auth_factors_dek_owner_fk;
--> statement-breakpoint
ALTER TABLE flaw.auth_factors ADD CONSTRAINT auth_factors_dek_owner_fk FOREIGN KEY (key_id, owner_id) REFERENCES flaw.user_keys (id, owner_id) ON DELETE NO ACTION;
--> statement-breakpoint
ALTER TABLE flaw.documents DROP CONSTRAINT documents_dek_owner_fk;
--> statement-breakpoint
ALTER TABLE flaw.documents ADD CONSTRAINT documents_dek_owner_fk FOREIGN KEY (key_id, owner_id) REFERENCES flaw.user_keys (id, owner_id) ON DELETE NO ACTION;
--> statement-breakpoint
ALTER TABLE flaw.document_states DROP CONSTRAINT document_states_dek_owner_fk;
--> statement-breakpoint
ALTER TABLE flaw.document_states ADD CONSTRAINT document_states_dek_owner_fk FOREIGN KEY (key_id, owner_id) REFERENCES flaw.user_keys (id, owner_id) ON DELETE NO ACTION;
--> statement-breakpoint
ALTER TABLE flaw.document_updates DROP CONSTRAINT document_updates_dek_owner_fk;
--> statement-breakpoint
ALTER TABLE flaw.document_updates ADD CONSTRAINT document_updates_dek_owner_fk FOREIGN KEY (key_id, owner_id) REFERENCES flaw.user_keys (id, owner_id) ON DELETE NO ACTION;
--> statement-breakpoint
ALTER TABLE flaw.document_versions DROP CONSTRAINT document_versions_dek_owner_fk;
--> statement-breakpoint
ALTER TABLE flaw.document_versions ADD CONSTRAINT document_versions_dek_owner_fk FOREIGN KEY (key_id, owner_id) REFERENCES flaw.user_keys (id, owner_id) ON DELETE NO ACTION;
