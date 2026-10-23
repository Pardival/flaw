/**
 * Lecture des secrets obligatoires.
 * Aucune règle n'est réécrite : readSecretFile est le validateur T-002
 * (identique à infra/creer-secrets.sh).
 */
import { dirname, join } from "node:path";

import { peppersMatchKek } from "../crypto/kek.ts";
import { readSecretFile, type SecretKind } from "../platform/healthz.ts";

export type SecretName = "databasePassword" | "betterAuthSecret" | "kek" | "recoveryPepper" | "hmacPepper";

export type OldRecoveryPepper = { id: string; value: string };

export type LoadedSecrets = Record<SecretName, string> & {
  oldRecoveryPeppers?: readonly OldRecoveryPepper[];
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

export function loadSecrets(env: NodeJS.ProcessEnv): SecretsResult {
  const secrets = {} as LoadedSecrets;
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
  const oldIds = (env.RECOVERY_PEPPER_OLD_IDS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  const recoveryPath = env.RECOVERY_PEPPER_FILE ?? "/run/secrets/recovery_pepper";
  const oldRecoveryPeppers: OldRecoveryPepper[] = [];
  for (const id of oldIds) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) {
      return { ok: false, message: "refus de démarrer : poivre" };
    }
    const read = readSecretFile(join(dirname(recoveryPath), `recovery_pepper_${id}`), "key");
    if (!read.ok) {
      return { ok: false, message: "refus de démarrer : poivre" };
    }
    oldRecoveryPeppers.push({ id, value: read.value });
  }
  return { ok: true, secrets: { ...secrets, oldRecoveryPeppers } };
}
