/**
 * Schéma Drizzle du schéma PostgreSQL `flaw` (T-005, A-003, A-014).
 *
 * 16 tables du pack, plus `auth_events` (Expert, échecs sans compte).
 * `verifications` est nommée par l'arbitrage T-002 #8.
 * `accounts` complète le compte : Better Auth est le choix A-002, et le pack
 * ne donne pas le seizième nom (schema-esquisse.sql est absent). Voir BLOCKER.
 *
 * Colonnes en clair de `documents` : mode, format, font (police), counter
 * (compteur), revision (champ serveur déjà retiré du client), dates.
 * La projection et les états CRDT sont des bytea chiffrés. Le titre n'est
 * pas une colonne en clair.
 *
 * RLS dès la v1 (A-014, plus strict que l'échéance PUB de SEC-DB-05) :
 * `owner_id = NULLIF(current_setting('app.user_id', true), '')::uuid`.
 * `users` compare `id` à la même expression.
 * ENABLE et les politiques sont déclarés ici. FORCE ROW LEVEL SECURITY est
 * dans la migration SQL : `enableRLS()` ne l'émet pas, et le propriétaire
 * flaw_owner contournerait sinon la RLS.
 *
 * `verifications.identifier` et `rate_limits.bucket` sont des HMAC-SHA256
 * poivrés (hex). Pas de RLS : elles servent avant qu'un utilisateur existe.
 * `auth_events` reçoit les échecs sans compte (insert seul pour flaw_app).
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  pgPolicy,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

const appUserId = sql`NULLIF(current_setting('app.user_id', true), '')::uuid`;

function timestamps() {
  return {
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  };
}

export const flaw = pgSchema("flaw");

export const users = flaw
  .table(
    "users",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      role: text("role").notNull().default("user"),
      ...timestamps(),
    },
    (table) => [
      check("users_role_check", sql`${table.role} in ('user', 'admin')`),
      pgPolicy("users_self", {
        for: "all",
        to: "flaw_app",
        using: sql`id = ${appUserId}`,
        withCheck: sql`id = ${appUserId}`,
      }),
    ],
  )
  .enableRLS();

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

function createdAt() {
  return timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow();
}

export const accounts = flaw
  .table(
    "accounts",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      ownerId: ownerId(),
      providerId: text("provider_id").notNull(),
      accountId: text("account_id").notNull(),
      createdAt: createdAt(),
    },
    (table) => [
      uniqueIndex("accounts_provider_account_uidx").on(table.providerId, table.accountId),
      index("accounts_owner_id_idx").on(table.ownerId),
      ownerPolicy("accounts"),
    ],
  )
  .enableRLS();

export const sessions = flaw
  .table(
    "sessions",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      ownerId: ownerId(),
      tokenHash: text("token_hash").notNull(),
      expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
      createdAt: createdAt(),
    },
    (table) => [
      uniqueIndex("sessions_token_hash_uidx").on(table.tokenHash),
      index("sessions_owner_id_idx").on(table.ownerId),
      ownerPolicy("sessions"),
    ],
  )
  .enableRLS();

/** Avant qu'un utilisateur existe. identifier = HMAC-SHA256 poivré, hex 64. */
export const verifications = flaw.table(
  "verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
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

export const authFactors = flaw
  .table(
    "auth_factors",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      ownerId: ownerId(),
      kind: text("kind").notNull(),
      secretCiphertext: bytea("secret_ciphertext").notNull(),
      createdAt: createdAt(),
    },
    (table) => [index("auth_factors_owner_id_idx").on(table.ownerId), ownerPolicy("auth_factors")],
  )
  .enableRLS();

export const recoveryCodes = flaw
  .table(
    "recovery_codes",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      ownerId: ownerId(),
      codeHash: text("code_hash").notNull(),
      usedAt: timestamp("used_at", { withTimezone: true, mode: "date" }),
      createdAt: createdAt(),
    },
    (table) => [index("recovery_codes_owner_id_idx").on(table.ownerId), ownerPolicy("recovery_codes")],
  )
  .enableRLS();

export const userKeys = flaw
  .table(
    "user_keys",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      ownerId: ownerId(),
      kekId: text("kek_id").notNull(),
      wrappedKey: bytea("wrapped_key").notNull(),
      createdAt: createdAt(),
    },
    (table) => [index("user_keys_owner_id_idx").on(table.ownerId), ownerPolicy("user_keys")],
  )
  .enableRLS();

export const userPreferences = flaw
  .table(
    "user_preferences",
    {
      ownerId: uuid("owner_id")
        .primaryKey()
        .references(() => users.id, { onDelete: "cascade" }),
      browserSpellcheck: boolean("browser_spellcheck").notNull().default(false),
      updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    },
    () => [ownerPolicy("user_preferences")],
  )
  .enableRLS();

export const dailyProgress = flaw
  .table(
    "daily_progress",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      ownerId: ownerId(),
      day: date("day", { mode: "string" }).notNull(),
      progressCount: integer("progress_count").notNull().default(0),
    },
    (table) => [
      uniqueIndex("daily_progress_owner_day_uidx").on(table.ownerId, table.day),
      ownerPolicy("daily_progress"),
    ],
  )
  .enableRLS();

/** Compteur avant authentification. bucket = HMAC-SHA256 poivré, hex 64. Pas de RLS. */
export const rateLimits = flaw.table(
  "rate_limits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bucket: text("bucket").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true, mode: "date" }).notNull(),
    hits: integer("hits").notNull(),
  },
  (table) => [
    check("rate_limits_bucket_hmac", sql`${table.bucket} ~ '^[0-9a-f]{64}$'`),
    uniqueIndex("rate_limits_bucket_window_uidx").on(table.bucket, table.windowStart),
  ],
);

/** Survit à la suppression de l'utilisateur : pas de clé étrangère. */
export const erasureLog = flaw
  .table(
    "erasure_log",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      ownerId: uuid("owner_id").notNull(),
      erasedAt: timestamp("erased_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    },
    (table) => [index("erasure_log_owner_id_idx").on(table.ownerId), ownerPolicy("erasure_log")],
  )
  .enableRLS();

/**
 * Journal sans contenu de texte. owner_id sans clé étrangère : la ligne peut
 * rester après l'effacement du compte. Les échecs sans utilisateur vont dans
 * auth_events. flaw_app n'a ni UPDATE ni DELETE.
 */
export const auditEvents = flaw
  .table(
    "audit_events",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      ownerId: uuid("owner_id").notNull(),
      eventType: text("event_type").notNull(),
      result: text("result").notNull(),
      createdAt: createdAt(),
    },
    (table) => [index("audit_events_owner_id_idx").on(table.ownerId), ownerPolicy("audit_events")],
  )
  .enableRLS();

/** Échecs d'authentification sans compte. HMAC poivrés, insert seul (SEC-LOG-02). */
export const authEvents = flaw
  .table(
    "auth_events",
    {
      id: uuid("id").primaryKey().defaultRandom(),
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
      pgPolicy("auth_events_insert", {
        for: "insert",
        to: "flaw_app",
        withCheck: sql`true`,
      }),
    ],
  )
  .enableRLS();

export const documents = flaw
  .table(
    "documents",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      ownerId: ownerId(),
      mode: text("mode").notNull(),
      format: text("format").notNull(),
      font: text("font").notNull(),
      counter: integer("counter").notNull().default(0),
      revision: integer("revision").notNull().default(0),
      projection: bytea("projection").notNull(),
      ...timestamps(),
    },
    (table) => [index("documents_owner_id_idx").on(table.ownerId), ownerPolicy("documents")],
  )
  .enableRLS();

export const documentStates = flaw
  .table(
    "document_states",
    {
      documentId: uuid("document_id")
        .primaryKey()
        .references(() => documents.id, { onDelete: "cascade" }),
      ownerId: ownerId(),
      ciphertext: bytea("ciphertext").notNull(),
      updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    },
    (table) => [index("document_states_owner_id_idx").on(table.ownerId), ownerPolicy("document_states")],
  )
  .enableRLS();

export const documentUpdates = flaw
  .table(
    "document_updates",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      documentId: uuid("document_id")
        .notNull()
        .references(() => documents.id, { onDelete: "cascade" }),
      ownerId: ownerId(),
      ciphertext: bytea("ciphertext").notNull(),
      createdAt: createdAt(),
    },
    (table) => [
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
      id: uuid("id").primaryKey().defaultRandom(),
      documentId: uuid("document_id")
        .notNull()
        .references(() => documents.id, { onDelete: "cascade" }),
      ownerId: ownerId(),
      ciphertext: bytea("ciphertext").notNull(),
      createdAt: createdAt(),
    },
    (table) => [
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

/** Tables soumises à la RLS forcée. */
export const RLS_TABLES = [
  "users",
  "accounts",
  "sessions",
  "auth_factors",
  "recovery_codes",
  "user_keys",
  "user_preferences",
  "daily_progress",
  "erasure_log",
  "audit_events",
  "auth_events",
  "documents",
  "document_states",
  "document_updates",
  "document_versions",
] as const;

/** Données utilisateur : owner_id NOT NULL et index (SEC-DATA-01, SEC-DB-05). */
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
