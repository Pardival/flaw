-- T-053 revue R1. Additive. Sur une ligne revoked, id, owner_id et status
-- ne bougent plus. wrapped_ct, wrapped_nonce, key_id et enc_version restent
-- modifiables pour rotate-kek. La suppression directe d'une DEK revoked est
-- refusée ; la cascade depuis users (profondeur > 1, droits du propriétaire)
-- reste possible.
CREATE OR REPLACE FUNCTION flaw.user_keys_keep_revoked()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'revoked' AND pg_trigger_depth() = 1 THEN
      RAISE EXCEPTION 'dek revoked immuable';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (
      SELECT 1
      FROM flaw.user_keys
      WHERE flaw.user_keys.id = NEW.id
        AND flaw.user_keys.status = 'revoked'
    ) THEN
      RAISE EXCEPTION 'dek revoked immuable';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'revoked' AND (
    NEW.id IS DISTINCT FROM OLD.id
    OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
    OR NEW.status IS DISTINCT FROM 'revoked'
  ) THEN
    RAISE EXCEPTION 'dek revoked immuable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS user_keys_keep_revoked ON flaw.user_keys;
--> statement-breakpoint
CREATE TRIGGER user_keys_keep_revoked
  BEFORE INSERT OR UPDATE OR DELETE ON flaw.user_keys
  FOR EACH ROW
  EXECUTE FUNCTION flaw.user_keys_keep_revoked();
