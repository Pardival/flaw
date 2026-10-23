-- T-018. Corbeille (deleted_at) et index de pagination de la liste.
ALTER TABLE flaw.documents ADD COLUMN deleted_at timestamptz;
--> statement-breakpoint
CREATE INDEX documents_owner_live_idx ON flaw.documents (owner_id, updated_at DESC, id DESC) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX documents_owner_trash_idx ON flaw.documents (owner_id, updated_at DESC, id DESC) WHERE deleted_at IS NOT NULL;
