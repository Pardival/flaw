/**
 * Charge la configuration publique puis les secrets.
 * Le message d'échec ne reprend jamais la valeur d'un secret.
 */
import { readPublicEnv, type PublicEnv } from "./env.ts";
import { loadSecrets, type LoadedSecrets } from "./secrets.ts";

let retainedSecrets: LoadedSecrets | undefined;

export function holdSecrets(secrets: LoadedSecrets): void {
  retainedSecrets = secrets;
}

export function secretsAreLoaded(): boolean {
  return retainedSecrets !== undefined;
}

export type AppConfig = PublicEnv & {
  allowSignup: boolean;
  bodyLimit: number;
  logLevel: PublicEnv["LOG_LEVEL"];
};

export type LoadResult =
  | { ok: true; config: AppConfig; secrets: LoadedSecrets }
  | { ok: false; message: string };

const DEBUG_LEVELS = new Set(["debug", "trace"]);

export function loadConfig(env: NodeJS.ProcessEnv): LoadResult {
  const parsed = readPublicEnv(env);
  if (parsed === null) {
    return { ok: false, message: "refus de démarrer : configuration invalide" };
  }
  if (parsed.NODE_ENV === "production" && DEBUG_LEVELS.has(parsed.LOG_LEVEL)) {
    return { ok: false, message: "refus de démarrer : journal de débogage interdit" };
  }
  const secrets = loadSecrets(env);
  if (!secrets.ok) {
    return secrets;
  }
  return {
    ok: true,
    secrets: secrets.secrets,
    config: {
      ...parsed,
      allowSignup: parsed.ALLOW_SIGNUP === "true",
      bodyLimit: parsed.MAX_DOCUMENT_SIZE_MB * 1024 * 1024,
      logLevel: parsed.LOG_LEVEL,
    },
  };
}
