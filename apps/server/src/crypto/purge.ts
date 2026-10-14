/**
 * Consigne le résultat de purge_journaux() dans flaw.audit_events.
 * Aucun contenu utilisateur : result est un code (ok, refus, erreur), en clair.
 * Les identifiants UUID sont les colonnes id et owner_id, pas le corps chiffré.
 */
import { CryptoError } from "@flaw/crypto";

export type SqlQuery = (sql: string, params: readonly unknown[]) => Promise<unknown>;

export type PurgeCode = "ok" | "refus" | "erreur";

export type PurgeConsigne = {
  id: string;
  ownerId: string;
  eventType: "purge_journaux";
  result: PurgeCode;
};

export class PurgeRefusee extends Error {
  constructor() {
    super("refus");
    this.name = "PurgeRefusee";
  }
}

function newId(explicit: string | undefined): string {
  if (explicit !== undefined) {
    if (explicit.length === 0) {
      throw new CryptoError("invalid_binding");
    }
    return explicit;
  }
  return globalThis.crypto.randomUUID();
}

function codePurge(error: unknown): "refus" | "erreur" {
  if (error instanceof PurgeRefusee) {
    return "refus";
  }
  return "erreur";
}

export async function consignerResultatPurge(input: {
  query: SqlQuery;
  purge: () => Promise<void>;
  ownerId: string;
  id?: string;
}): Promise<PurgeConsigne> {
  const id = newId(input.id);
  let result: PurgeCode = "ok";
  let failure: unknown;
  try {
    await input.purge();
  } catch (error) {
    result = codePurge(error);
    failure = error;
  }
  await input.query(
    "INSERT INTO flaw.audit_events (id, owner_id, event_type, result) VALUES ($1, $2, $3, $4)",
    [id, input.ownerId, "purge_journaux", result],
  );
  if (failure !== undefined) {
    throw failure;
  }
  return { id, ownerId: input.ownerId, eventType: "purge_journaux", result };
}
