-- T-008 revue / Q-015. Additive.
-- Registre des KEK : `active` chiffre, `retired` ne chiffre plus et reste
-- disponible pour déchiffrer. rotate-kek ne détruit aucun fichier.
-- La destruction planifiée est hors périmètre (T-042).
CREATE TABLE flaw.keks (
  id text PRIMARY KEY,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT keks_status_check CHECK (status IN ('active', 'retired'))
);
--> statement-breakpoint
-- Anti-rejeu TOTP : une seule ligne par identifiant, mise à jour conditionnelle.
DELETE FROM flaw.verifications AS v
WHERE v.ctid IN (
  SELECT ranked.ctid
  FROM (
    SELECT ctid, row_number() OVER (PARTITION BY identifier ORDER BY expires_at DESC, ctid DESC) AS rn
    FROM flaw.verifications
  ) AS ranked
  WHERE ranked.rn > 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX verifications_identifier_uidx ON flaw.verifications (identifier);
--> statement-breakpoint
-- Une DEK revoked ne redevient ni active ni retired.
CREATE FUNCTION flaw.user_keys_keep_revoked()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.status = 'revoked' AND NEW.status IS DISTINCT FROM 'revoked' THEN
    RAISE EXCEPTION 'dek revoked immuable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER user_keys_keep_revoked
  BEFORE UPDATE ON flaw.user_keys
  FOR EACH ROW
  EXECUTE FUNCTION flaw.user_keys_keep_revoked();
