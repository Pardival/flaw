/**
 * Schéma Drizzle du schéma PostgreSQL `flaw` (T-005, ARC-SUM 0.4.16).
 *
 * 17 tables. `erasure_outbox` et `erasure_journal_head` restent hors de ce
 * décompte (instruction de reprise ; le critère du pack en cite 19).
 * Pas de colonne de titre : le titre chiffré est T-006. La projection
 * chiffrée est l'enveloppe `projection_ct`.
 *
 * RLS forcée seulement sur les 4 tables de contenu. `users`, `accounts` et
 * `sessions` n'ont pas de RLS. Le prédicat est
 * `owner_id = NULLIF(current_setting('app.user_id', true), '')::uuid`.
 * FORCE est dans le SQL : `enableRLS()` ne l'émet pas.
 *
 * Identifiants : `uuidv7()`, sauf `documents.id` qui n'a pas de défaut.
 * Enveloppe : `*_ct`, `*_nonce`, `key_id`, `enc_version`.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  pgPolicy,
  pgSchema,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

const appUserId = sql`NULLIF(current_setting('app.user_id', true), '')::uuid`;

function uuidv7(name: string) {
  return uuid(name).primaryKey().default(sql`uuidv7()`);
}

function createdAt() {
  return timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow();
}

function timestamps() {
  return {
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  };
}

export const flaw = pgSchema("flaw");

export const users = flaw.table(
  "users",
  {
    id: uuidv7("id"),
    role: text("role").notNull().default("user"),
    ...timestamps(),
  },
  (table) => [check("users_role_check", sql`${table.role} in ('user', 'admin')`)],
);

function ownerId() {
  return uuid("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" });
}

function ownerPolicy(name: string) {
  return pgPolicy(`${name}_owner`, {
    for: "all",
    to: "flaw_app",
    using: sql`owner_id = ${appUserId}`,
    withCheck: sql`owner_id = ${appUserId}`,
  });
}

export const accounts = flaw.table(
  "accounts",
  {
    id: uuidv7("id"),
    ownerId: ownerId(),
    providerId: text("provider_id").notNull(),
    accountId: text("account_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("accounts_provider_account_uidx").on(table.providerId, table.accountId),
    index("accounts_owner_id_idx").on(table.ownerId),
  ],
);

export const sessions = flaw.table(
  "sessions",
  {
    id: uuidv7("id"),
    ownerId: ownerId(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("sessions_token_hash_uidx").on(table.tokenHash),
    index("sessions_owner_id_idx").on(table.ownerId),
  ],
);

/** identifier = HMAC-SHA256 poivré (hmac_pepper), hex 64. Pas de RLS. */
export const verifications = flaw.table(
  "verifications",
  {
    id: uuidv7("id"),
    identifier: text("identifier").notNull(),
    valueHash: text("value_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    check("verifications_identifier_hmac", sql`${table.identifier} ~ '^[0-9a-f]{64}$'`),
    index("verifications_identifier_idx").on(table.identifier),
  ],
);

export const authFactors = flaw.table(
  "auth_factors",
  {
    id: uuidv7("id"),
    ownerId: ownerId(),
    kind: text("kind").notNull(),
    secretCt: bytea("secret_ct").notNull(),
    secretNonce: bytea("secret_nonce").notNull(),
    keyId: text("key_id").notNull(),
    encVersion: integer("enc_version").notNull(),
    createdAt: createdAt(),
  },
  (table) => [index("auth_factors_owner_id_idx").on(table.ownerId)],
);

export const recoveryCodes = flaw.table(
  "recovery_codes",
  {
    id: uuidv7("id"),
    ownerId: ownerId(),
    codeHash: text("code_hash").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
  },
  (table) => [index("recovery_codes_owner_id_idx").on(table.ownerId)],
);

export const userKeys = flaw.table(
  "user_keys",
  {
    id: uuidv7("id"),
    ownerId: ownerId(),
    wrappedCt: bytea("wrapped_ct").notNull(),
    wrappedNonce: bytea("wrapped_nonce").notNull(),
    keyId: text("key_id").notNull(),
    encVersion: integer("enc_version").notNull(),
    createdAt: createdAt(),
  },
  (table) => [index("user_keys_owner_id_idx").on(table.ownerId)],
);

export const userPreferences = flaw.table("user_preferences", {
  ownerId: uuid("owner_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  browserSpellcheck: boolean("browser_spellcheck").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export const dailyProgress = flaw.table(
  "daily_progress",
  {
    id: uuidv7("id"),
    ownerId: ownerId(),
    day: date("day", { mode: "string" }).notNull(),
    progressCount: integer("progress_count").notNull().default(0),
  },
  (table) => [uniqueIndex("daily_progress_owner_day_uidx").on(table.ownerId, table.day)],
);

/** bucket = HMAC-SHA256 poivré, hex 64. Pas de RLS. */
export const rateLimits = flaw.table(
  "rate_limits",
  {
    id: uuidv7("id"),
    bucket: text("bucket").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true, mode: "date" }).notNull(),
    hits: integer("hits").notNull(),
  },
  (table) => [
    check("rate_limits_bucket_hmac", sql`${table.bucket} ~ '^[0-9a-f]{64}$'`),
    uniqueIndex("rate_limits_bucket_window_uidx").on(table.bucket, table.windowStart),
  ],
);

/**
 * owner_id est posé par le déclencheur journaliser_effacement.
 * flaw_app n'a que SELECT. Rétention 440 jours (purge_journaux).
 */
export const erasureLog = flaw.table(
  "erasure_log",
  {
    id: uuidv7("id"),
    subject: text("subject").notNull(),
    subjectId: uuid("subject_id").notNull(),
    ownerId: uuid("owner_id").notNull(),
    origine: text("origine").notNull().default("effacement"),
    erasedAt: timestamp("erased_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    check("erasure_log_subject_check", sql`${table.subject} in ('user', 'document')`),
    check("erasure_log_origine_check", sql`${table.origine} in ('effacement', 'rejeu')`),
    check(
      "erasure_log_owner_user",
      sql`${table.subject} <> 'user' OR ${table.ownerId} = ${table.subjectId}`,
    ),
    check(
      "erasure_log_owner_document",
      sql`${table.subject} <> 'document' OR ${table.ownerId} IS NOT NULL`,
    ),
    index("erasure_log_owner_id_idx").on(table.ownerId),
  ],
);

/** SELECT et INSERT pour flaw_app. Pas de RLS. Pas d'UPDATE ni de DELETE. */
export const auditEvents = flaw.table(
  "audit_events",
  {
    id: uuidv7("id"),
    ownerId: uuid("owner_id").notNull(),
    eventType: text("event_type").notNull(),
    result: text("result").notNull(),
    createdAt: createdAt(),
  },
  (table) => [index("audit_events_owner_id_idx").on(table.ownerId)],
);

/** Échecs sans compte. INSERT seul. Identifiants HMAC. Pas de RLS. */
export const authEvents = flaw.table(
  "auth_events",
  {
    id: uuidv7("id"),
    eventType: text("event_type").notNull(),
    subjectHmac: text("subject_hmac"),
    ipHmac: text("ip_hmac"),
    userAgentSummary: text("user_agent_summary"),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      "auth_events_event_type_check",
      sql`${table.eventType} in ('login_failed', 'login_rate_limited', 'mfa_failed')`,
    ),
  ],
);

export const documents = flaw
  .table(
    "documents",
    {
      id: uuid("id").primaryKey(),
      ownerId: ownerId(),
      mode: text("mode").notNull(),
      format: text("format").notNull(),
      font: text("font").notNull(),
      counter: integer("counter").notNull().default(0),
      revision: integer("revision").notNull().default(0),
      projectionCt: bytea("projection_ct").notNull(),
      projectionNonce: bytea("projection_nonce").notNull(),
      keyId: text("key_id").notNull(),
      encVersion: integer("enc_version").notNull(),
      ...timestamps(),
    },
    (table) => [
      unique("documents_id_owner_uidx").on(table.id, table.ownerId),
      index("documents_owner_id_idx").on(table.ownerId),
      ownerPolicy("documents"),
    ],
  )
  .enableRLS();

export const documentStates = flaw
  .table(
    "document_states",
    {
      documentId: uuid("document_id").primaryKey(),
      ownerId: ownerId(),
      stateCt: bytea("state_ct").notNull(),
      stateNonce: bytea("state_nonce").notNull(),
      keyId: text("key_id").notNull(),
      encVersion: integer("enc_version").notNull(),
      updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    },
    (table) => [
      foreignKey({
        columns: [table.documentId, table.ownerId],
        foreignColumns: [documents.id, documents.ownerId],
        name: "document_states_document_owner_fk",
      }).onDelete("cascade"),
      index("document_states_owner_id_idx").on(table.ownerId),
      ownerPolicy("document_states"),
    ],
  )
  .enableRLS();

export const documentUpdates = flaw
  .table(
    "document_updates",
    {
      id: uuidv7("id"),
      documentId: uuid("document_id").notNull(),
      ownerId: ownerId(),
      updateCt: bytea("update_ct").notNull(),
      updateNonce: bytea("update_nonce").notNull(),
      keyId: text("key_id").notNull(),
      encVersion: integer("enc_version").notNull(),
      createdAt: createdAt(),
    },
    (table) => [
      foreignKey({
        columns: [table.documentId, table.ownerId],
        foreignColumns: [documents.id, documents.ownerId],
        name: "document_updates_document_owner_fk",
      }).onDelete("cascade"),
      index("document_updates_owner_id_idx").on(table.ownerId),
      index("document_updates_document_id_idx").on(table.documentId),
      ownerPolicy("document_updates"),
    ],
  )
  .enableRLS();

export const documentVersions = flaw
  .table(
    "document_versions",
    {
      id: uuidv7("id"),
      documentId: uuid("document_id").notNull(),
      ownerId: ownerId(),
      versionCt: bytea("version_ct").notNull(),
      versionNonce: bytea("version_nonce").notNull(),
      keyId: text("key_id").notNull(),
      encVersion: integer("enc_version").notNull(),
      createdAt: createdAt(),
    },
    (table) => [
      foreignKey({
        columns: [table.documentId, table.ownerId],
        foreignColumns: [documents.id, documents.ownerId],
        name: "document_versions_document_owner_fk",
      }).onDelete("cascade"),
      index("document_versions_owner_id_idx").on(table.ownerId),
      index("document_versions_document_id_idx").on(table.documentId),
      ownerPolicy("document_versions"),
    ],
  )
  .enableRLS();

export const TABLE_NAMES = [
  "users",
  "accounts",
  "sessions",
  "verifications",
  "auth_factors",
  "recovery_codes",
  "user_keys",
  "user_preferences",
  "daily_progress",
  "rate_limits",
  "erasure_log",
  "audit_events",
  "auth_events",
  "documents",
  "document_states",
  "document_updates",
  "document_versions",
] as const;

/** RLS forcée : exactement les 4 tables de contenu. */
export const RLS_TABLES = [
  "documents",
  "document_states",
  "document_updates",
  "document_versions",
] as const;

export const OWNER_TABLES = [
  "accounts",
  "sessions",
  "auth_factors",
  "recovery_codes",
  "user_keys",
  "user_preferences",
  "daily_progress",
  "erasure_log",
  "audit_events",
  "documents",
  "document_states",
  "document_updates",
  "document_versions",
] as const;

export const APP_USER_PREDICATE = "NULLIF(current_setting('app.user_id', true), '')::uuid";
