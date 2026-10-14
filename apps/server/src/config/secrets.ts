/**
 * Lecture des secrets obligatoires.
 * Aucune règle n'est réécrite : readSecretFile est le validateur T-002
 * (identique à infra/creer-secrets.sh).
 */
import { readSecretFile, type SecretKind } from "../platform/healthz.ts";

export type SecretName = "databasePassword" | "betterAuthSecret" | "kek" | "recoveryPepper" | "hmacPepper";

export type LoadedSecrets = Record<SecretName, string>;

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
  return { ok: true, secrets };
}
