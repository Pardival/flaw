-- T-010. Horodatage de la dernière authentification complète
-- (mot de passe + facteur) portée par la session. API-004 l'exige
-- de moins de 5 minutes. Les sessions déjà ouvertes reprennent created_at.
ALTER TABLE flaw.sessions ADD COLUMN reauthenticated_at timestamptz;
--> statement-breakpoint
UPDATE flaw.sessions SET reauthenticated_at = created_at WHERE reauthenticated_at IS NULL;
--> statement-breakpoint
ALTER TABLE flaw.sessions ALTER COLUMN reauthenticated_at SET NOT NULL;
