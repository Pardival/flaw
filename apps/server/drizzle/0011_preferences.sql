-- T-028. Préférences du compte (API-006/007) : réglages non sensibles, dernier écrit gagne.
ALTER TABLE flaw.user_preferences ADD COLUMN settings jsonb NOT NULL DEFAULT '{}'::jsonb;
