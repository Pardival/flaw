-- T-008. Additive.
-- Session restreinte : 15 min, liste blanche, enrôlement seulement après
-- un mot de passe provisoire. Le plafond est aussi appliqué dans le serveur
-- à partir de created_at, pas seulement par absolute_expires_at.
ALTER TABLE flaw.sessions ADD COLUMN restricted boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- Q-011. Révocation explicite d'une DEK : nouvelle valeur `revoked`.
-- `retired` reste résoluble (contenu historique). `revoked` refuse la résolution.
-- L'ancienne contrainte active/retired de 0001 n'est pas réécrite.
ALTER TABLE flaw.user_keys DROP CONSTRAINT user_keys_status_check;
--> statement-breakpoint
ALTER TABLE flaw.user_keys ADD CONSTRAINT user_keys_status_check CHECK (status IN ('active', 'retired', 'revoked'));
