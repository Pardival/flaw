-- T-032. Historique : raison de la version et compteur (en clair, non sensibles).
ALTER TABLE flaw.document_versions ADD COLUMN reason text NOT NULL DEFAULT 'auto';
--> statement-breakpoint
ALTER TABLE flaw.document_versions ADD COLUMN word_count integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE flaw.document_versions ADD CONSTRAINT document_versions_reason_check CHECK (reason IN ('auto', 'session_end', 'manual', 'before_restore', 'before_delete', 'before_merge', 'before_layout_change', 'import'));
