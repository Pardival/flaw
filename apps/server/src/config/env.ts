/**
 * Configuration non secrète (variables déjà définies par infra/docker-compose.yml).
 * Les fichiers de secrets ne sont pas validés ici : SEC-SECRET-07 passe par
 * readSecretFile (apps/server/src/platform/healthz.ts).
 */
import { z } from "zod";

const httpUrl = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
});

const httpsUrl = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:";
  } catch {
    return false;
  }
});

export const publicEnvSchema = z
  .object({
    NODE_ENV: z.enum(["production", "development", "test"]).default("production"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    PUBLIC_URL: httpUrl.optional(),
    TRUSTED_ORIGINS: z.string().default(""),
    TRUSTED_PROXY_CIDR: z.string().default(""),
    DATABASE_HOST: z.string().min(1).default("db"),
    DATABASE_NAME: z.string().min(1).default("flaw"),
    DATABASE_USER: z.string().min(1).default("flaw_app"),
    FLAW_KEK_ID: z.string().min(1).default("kek-2026-10"),
    RECOVERY_PEPPER_ID: z.string().min(1).default("pep-2026-10"),
    RECOVERY_PEPPER_OLD_IDS: z.string().default(""),
    HMAC_PEPPER_ID: z.string().min(1).default("pep-hmac-2026-10"),
    ALLOW_SIGNUP: z.enum(["true", "false"]).default("false"),
    FLAW_AUTH_BEARER_ENABLED: z.enum(["true", "false"]).default("false"),
    SESSION_IDLE_DAYS: z.coerce.number().int().min(1).default(30),
    SESSION_MAX_DAYS: z.coerce.number().int().min(1).default(90),
    SESSION_REVALIDATE_SECONDS: z.coerce.number().int().min(1).default(30),
    MAX_DOCUMENT_SIZE_MB: z.coerce.number().int().min(1).max(10).default(10),
    MAX_WS_MESSAGE_MB: z.coerce.number().int().min(1).default(10),
    EXPORT_TIMEOUT_SECONDS: z.coerce.number().int().min(1).default(60),
    EXPORT_MAX_CONCURRENCY: z.coerce.number().int().min(1).default(1),
    EXPORT_MAX_RSS_MB: z.coerce.number().int().min(1).default(900),
    PASSWORD_MIN_LENGTH: z.coerce.number().int().min(8).default(15),
    SNAPSHOT_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
    ALERT_WEBHOOK_URL: z.union([z.literal(""), httpsUrl]).default(""),
  })
  .superRefine((data, context) => {
    if (data.MAX_WS_MESSAGE_MB > data.MAX_DOCUMENT_SIZE_MB) {
      context.addIssue({
        code: "custom",
        path: ["MAX_WS_MESSAGE_MB"],
        message: "plafond",
      });
    }
  });

export type PublicEnv = z.infer<typeof publicEnvSchema>;

export function readPublicEnv(env: NodeJS.ProcessEnv): PublicEnv | null {
  const parsed = publicEnvSchema.safeParse({
    NODE_ENV: env.NODE_ENV,
    LOG_LEVEL: env.LOG_LEVEL,
    PORT: env.PORT,
    PUBLIC_URL: env.PUBLIC_URL,
    TRUSTED_ORIGINS: env.TRUSTED_ORIGINS,
    TRUSTED_PROXY_CIDR: env.TRUSTED_PROXY_CIDR,
    DATABASE_HOST: env.DATABASE_HOST,
    DATABASE_NAME: env.DATABASE_NAME,
    DATABASE_USER: env.DATABASE_USER,
    FLAW_KEK_ID: env.FLAW_KEK_ID,
    RECOVERY_PEPPER_ID: env.RECOVERY_PEPPER_ID,
    RECOVERY_PEPPER_OLD_IDS: env.RECOVERY_PEPPER_OLD_IDS,
    HMAC_PEPPER_ID: env.HMAC_PEPPER_ID,
    ALLOW_SIGNUP: env.ALLOW_SIGNUP,
    FLAW_AUTH_BEARER_ENABLED: env.FLAW_AUTH_BEARER_ENABLED,
    SESSION_IDLE_DAYS: env.SESSION_IDLE_DAYS,
    SESSION_MAX_DAYS: env.SESSION_MAX_DAYS,
    SESSION_REVALIDATE_SECONDS: env.SESSION_REVALIDATE_SECONDS,
    MAX_DOCUMENT_SIZE_MB: env.MAX_DOCUMENT_SIZE_MB,
    MAX_WS_MESSAGE_MB: env.MAX_WS_MESSAGE_MB,
    EXPORT_TIMEOUT_SECONDS: env.EXPORT_TIMEOUT_SECONDS,
    EXPORT_MAX_CONCURRENCY: env.EXPORT_MAX_CONCURRENCY,
    EXPORT_MAX_RSS_MB: env.EXPORT_MAX_RSS_MB,
    PASSWORD_MIN_LENGTH: env.PASSWORD_MIN_LENGTH,
    SNAPSHOT_RETENTION_DAYS: env.SNAPSHOT_RETENTION_DAYS,
    ALERT_WEBHOOK_URL: env.ALERT_WEBHOOK_URL,
  });
  if (!parsed.success) {
    return null;
  }
  return parsed.data;
}
