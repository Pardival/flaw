/**
 * Lecture des secrets obligatoires.
 * Aucune règle n'est réécrite : readSecretFile est le validateur T-002
 * (identique à infra/creer-secrets.sh).
 * Les anciens poivres sont recovery_pepper_<id> à côté de RECOVERY_PEPPER_FILE
 * (/run/secrets/recovery_pepper_<id> dans Compose).
 */
import { dirname, join } from "node:path";

import { peppersMatchKek } from "../crypto/kek.ts";
import { readSecretFile, type SecretKind } from "../platform/healthz.ts";
import { parseRecoveryPepperOldIds } from "./env.ts";

export type SecretName = "databasePassword" | "betterAuthSecret" | "kek" | "recoveryPepper" | "hmacPepper";

export type LoadedSecrets = Record<SecretName, string> & {
  recoveryPepperOld: Readonly<Record<string, string>>;
};

type SecretSpec = {
  name: SecretName;
  env: "DATABASE_PASSWORD_FILE" | "BETTER_AUTH_SECRET_FILE" | "FLAW_KEK_FILE" | "RECOVERY_PEPPER_FILE" | "HMAC_PEPPER_FILE";
  fallback: string;
  kind: SecretKind;
};

const SPECS: readonly SecretSpec[] = [
  {
    name: "databasePassword",
    env: "DATABASE_PASSWORD_FILE",
    fallback: "/run/secrets/app_db_password",
    kind: "secret",
  },
  {
    name: "betterAuthSecret",
    env: "BETTER_AUTH_SECRET_FILE",
    fallback: "/run/secrets/better_auth_secret",
    kind: "secret",
  },
  {
    name: "kek",
    env: "FLAW_KEK_FILE",
    fallback: "/run/secrets/flaw_kek",
    kind: "key",
  },
  {
    name: "recoveryPepper",
    env: "RECOVERY_PEPPER_FILE",
    fallback: "/run/secrets/recovery_pepper",
    kind: "key",
  },
  {
    name: "hmacPepper",
    env: "HMAC_PEPPER_FILE",
    fallback: "/run/secrets/hmac_pepper",
    kind: "key",
  },
];

export type SecretsResult =
  | { ok: true; secrets: LoadedSecrets }
  | { ok: false; message: string };

function currentRecoveryPepperId(env: NodeJS.ProcessEnv): string {
  const value = env.RECOVERY_PEPPER_ID;
  if (value === undefined || value.length === 0) {
    return "pep-2026-10";
  }
  return value;
}

/** Chaque id de RECOVERY_PEPPER_OLD_IDS, validé par readSecretFile(..., "key"). */
export function loadOldRecoveryPeppers(
  env: NodeJS.ProcessEnv,
  kek: string,
  hmacPepper: string,
): { ok: true; peppers: Record<string, string> } | { ok: false; message: string } {
  const parsed = parseRecoveryPepperOldIds(currentRecoveryPepperId(env), env.RECOVERY_PEPPER_OLD_IDS);
  if (!parsed.ok) {
    return { ok: false, message: "refus de démarrer : poivre" };
  }
  const directory = dirname(env.RECOVERY_PEPPER_FILE ?? "/run/secrets/recovery_pepper");
  const peppers: Record<string, string> = {};
  for (const id of parsed.ids) {
    const result = readSecretFile(join(directory, `recovery_pepper_${id}`), "key");
    if (!result.ok) {
      return result;
    }
    if (peppersMatchKek(kek, hmacPepper, result.value)) {
      return { ok: false, message: "refus de démarrer : poivre" };
    }
    peppers[id] = result.value;
  }
  return { ok: true, peppers };
}

export function loadSecrets(env: NodeJS.ProcessEnv): SecretsResult {
  const secrets = { recoveryPepperOld: {} } as LoadedSecrets;
  for (const spec of SPECS) {
    const filePath = env[spec.env] ?? spec.fallback;
    const result = readSecretFile(filePath, spec.kind);
    if (!result.ok) {
      return result;
    }
    secrets[spec.name] = result.value;
  }
  if (peppersMatchKek(secrets.kek, secrets.hmacPepper, secrets.recoveryPepper)) {
    return { ok: false, message: "refus de démarrer : poivre" };
  }
  const old = loadOldRecoveryPeppers(env, secrets.kek, secrets.hmacPepper);
  if (!old.ok) {
    return old;
  }
  secrets.recoveryPepperOld = old.peppers;
  return { ok: true, secrets };
}
