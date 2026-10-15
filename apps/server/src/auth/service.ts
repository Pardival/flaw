/**
 * Authentification par mot de passe et sessions opaques hachées.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";

import type { SecurityEvent } from "../platform/security-log.ts";
import { deviceLabel, summarizeDevice } from "./device.ts";
import { hashSessionToken, newSessionToken } from "./cookie.ts";
import { bucketHmac, hmacKey, ipHmac, subjectHmac, tempHmac } from "./hmac.ts";
import {
  ARGON_TARGET,
  assessPassword,
  assertArgonParams,
  assertPasswordMinLength,
  dummyPasswordMaterial,
  hashPassword,
  passwordNeedsRehash,
  provisionalPassword,
  verifyPassword,
  type ArgonParams,
} from "./password.ts";
import {
  absentUserId,
  activeLock,
  bumpRate,
  countUsers,
  deleteBuckets,
  deleteDocument,
  deleteVerification,
  findAccount,
  findAccountByUser,
  findSession,
  findVerification,
  insertAccount,
  insertAudit,
  insertAuthEvent,
  insertLock,
  insertSession,
  insertUser,
  insertVerification,
  listDevices,
  listDocuments,
  maxLockStage,
  revokeAllSessions,
  revokeOtherSessions,
  revokeSession,
  setPassword,
  touchSession,
  type SessionRow,
} from "./store.ts";

const WINDOW_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const TEMP_TTL_MS = DAY_MS;
const LOCK_DELAYS = [60, 300, 900];

export type AuthDeps = {
  pool: Pool;
  pepper: string;
  pepperId: string;
  minLength: number;
  idleDays: number;
  maxDays: number;
  argon: ArgonParams;
  now: () => Date;
  onEvent?: (event: SecurityEvent) => void;
};

export type SignInResult =
  | {
      kind: "ok";
      token: string;
      maxAge: number | null;
      userId: string;
      identifier: string;
      sessionId: string;
    }
  | { kind: "invalid" }
  | { kind: "limited"; retryAfter: number };

type AttemptContext = {
  identifier: string;
  password: string;
  ip: string;
  userAgent: string | undefined;
  remember: boolean;
};

function windowStart(now: Date): Date {
  return new Date(Math.floor(now.getTime() / WINDOW_MS) * WINDOW_MS);
}

function delayForStage(stage: number): number {
  const index = Math.min(Math.max(stage, 1), LOCK_DELAYS.length) - 1;
  return LOCK_DELAYS[index] ?? 900;
}

function retrySeconds(until: Date, now: Date): number {
  return Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 1000));
}

export function openAuth(deps: AuthDeps) {
  assertPasswordMinLength(deps.minLength);
  assertArgonParams(deps.argon);
  const key = hmacKey(deps.pepper, deps.pepperId);
  let dummy: Promise<string> | null = null;

  function dummyHash(): Promise<string> {
    dummy ??= hashPassword(dummyPasswordMaterial(), deps.argon);
    return dummy;
  }

  function emit(event: SecurityEvent): void {
    deps.onEvent?.(event);
  }

  async function checkSecret(password: string, hashed: string | null): Promise<boolean> {
    const material = hashed !== null && hashed.startsWith("$argon2id$") ? hashed : await dummyHash();
    const matches = await verifyPassword(password, material);
    return hashed !== null && hashed.startsWith("$argon2id$") && matches;
  }

  async function signIn(input: AttemptContext): Promise<SignInResult> {
    const now = deps.now();
    const device = summarizeDevice(input.userAgent);
    const summary = deviceLabel(device);
    const ipBucket = bucketHmac(key, `ip|${input.ip}`);
    const ipHits = await bumpRate(deps.pool, ipBucket, windowStart(now));
    if (ipHits > 20) {
      await insertAuthEvent(
        deps.pool,
        "login_rate_limited",
        subjectHmac(key, input.identifier),
        ipHmac(key, input.ip),
        summary,
      );
      emit({ type: "rate_limited", result: "echec", ip: input.ip, userAgent: input.userAgent ?? null });
      return { kind: "limited", retryAfter: retrySeconds(new Date(windowStart(now).getTime() + WINDOW_MS), now) };
    }

    const account = await findAccount(deps.pool, input.identifier);
    const lockBucket = bucketHmac(key, `acct-lock|${input.identifier}`);
    const lockedUntil = await activeLock(deps.pool, lockBucket, now);
    const password = input.password.normalize("NFC");
    const matches = await checkSecret(password, account?.password_hash ?? null);
    const tempId = tempHmac(key, account?.user_id ?? absentUserId());
    const tempExpires = await findVerification(deps.pool, tempId);
    const expired = tempExpires !== null && now.getTime() >= tempExpires.getTime();
    const accepted = matches && !expired && account !== null;

    if (lockedUntil !== null) {
      await insertAuthEvent(
        deps.pool,
        "login_rate_limited",
        subjectHmac(key, input.identifier),
        ipHmac(key, input.ip),
        summary,
      );
      emit({
        type: "rate_limited",
        result: "echec",
        userId: account?.user_id ?? null,
        ip: input.ip,
        userAgent: input.userAgent ?? null,
      });
      return { kind: "limited", retryAfter: retrySeconds(lockedUntil, now) };
    }

    if (!accepted || account === null) {
      await registerFailure(input.identifier, now);
      await insertAuthEvent(
        deps.pool,
        "login_failed",
        subjectHmac(key, input.identifier),
        ipHmac(key, input.ip),
        summary,
      );
      emit({
        type: "login_failure",
        result: "echec",
        userId: account?.user_id ?? null,
        ip: input.ip,
        userAgent: input.userAgent ?? null,
      });
      return { kind: "invalid" };
    }

    if (account.password_hash !== null && passwordNeedsRehash(account.password_hash, deps.argon)) {
      await setPassword(deps.pool, account.user_id, await hashPassword(password, deps.argon));
    }
    const failBucket = bucketHmac(key, `acct-fail|${input.identifier}`);
    await deleteBuckets(deps.pool, [failBucket, lockBucket]);
    const bounds = boundsFor(input.remember, now);
    const issued = newSessionToken();
    const sessionId = await insertSession(deps.pool, {
      userId: account.user_id,
      tokenHash: issued.hash,
      expiresAt: bounds.idle,
      absoluteExpiresAt: bounds.absolute,
      createdAt: now,
      browser: device.browser,
      os: device.os,
      remember: input.remember,
    });
    await insertAudit(deps.pool, account.user_id, "login_success", "ok");
    emit({
      type: "login_success",
      result: "succes",
      userId: account.user_id,
      sessionId,
      ip: input.ip,
      userAgent: input.userAgent ?? null,
    });
    emit({
      type: "session_created",
      result: "succes",
      userId: account.user_id,
      sessionId,
      ip: input.ip,
      userAgent: input.userAgent ?? null,
    });
    return {
      kind: "ok",
      token: issued.token,
      maxAge: input.remember ? deps.maxDays * 24 * 60 * 60 : null,
      userId: account.user_id,
      identifier: input.identifier,
      sessionId,
    };
  }

  async function registerFailure(identifier: string, now: Date): Promise<void> {
    const bucket = bucketHmac(key, `acct-fail|${identifier}`);
    const hits = await bumpRate(deps.pool, bucket, windowStart(now));
    if (hits < 5) {
      return;
    }
    const lockBucket = bucketHmac(key, `acct-lock|${identifier}`);
    const stage = (await maxLockStage(deps.pool, lockBucket)) + 1;
    const until = new Date(now.getTime() + delayForStage(stage) * 1000);
    await insertLock(deps.pool, lockBucket, until, stage);
  }

  function boundsFor(remember: boolean, now: Date): { idle: Date; absolute: Date } {
    const idleMs = (remember ? deps.idleDays : 1) * DAY_MS;
    const absoluteMs = (remember ? deps.maxDays : 1) * DAY_MS;
    return {
      idle: new Date(now.getTime() + idleMs),
      absolute: new Date(now.getTime() + absoluteMs),
    };
  }

  async function resolve(token: string | undefined): Promise<SessionRow | null> {
    if (token === undefined) {
      return null;
    }
    const row = await findSession(deps.pool, hashSessionToken(token));
    if (row === null || row.revoked_at !== null) {
      return null;
    }
    const now = deps.now();
    if (now.getTime() >= row.absolute_expires_at.getTime() || now.getTime() >= row.expires_at.getTime()) {
      return null;
    }
    const idleMs = (row.remember ? deps.idleDays : 1) * DAY_MS;
    const nextIdle = new Date(now.getTime() + idleMs);
    const expires = nextIdle < row.absolute_expires_at ? nextIdle : row.absolute_expires_at;
    if (expires.getTime() <= now.getTime()) {
      return null;
    }
    await touchSession(deps.pool, row.id, now, expires);
    return row;
  }

  async function signOut(sessionId: string, userId: string, ip: string, userAgent: string | undefined): Promise<void> {
    const now = deps.now();
    await revokeSession(deps.pool, sessionId, now);
    await insertAudit(deps.pool, userId, "session_revoked", "ok");
    emit({ type: "session_revoked", result: "succes", userId, sessionId, ip, userAgent: userAgent ?? null });
  }

  async function changePassword(
    userId: string,
    sessionId: string,
    currentPassword: string,
    nextPassword: string,
    ip: string,
    userAgent: string | undefined,
  ): Promise<"ok" | "invalid" | "rejected"> {
    const account = await findAccountByUser(deps.pool, userId);
    if (account?.password_hash == null) {
      return "invalid";
    }
    const current = currentPassword.normalize("NFC");
    const matches = await verifyPassword(current, account.password_hash);
    if (!matches) {
      return "invalid";
    }
    const assessed = assessPassword(nextPassword, deps.minLength);
    if (!assessed.ok) {
      return "rejected";
    }
    const hashed = await hashPassword(assessed.password, deps.argon);
    const now = deps.now();
    await setPassword(deps.pool, userId, hashed);
    await deleteVerification(deps.pool, tempHmac(key, userId));
    await revokeOtherSessions(deps.pool, userId, sessionId, now);
    await insertAudit(deps.pool, userId, "password_changed", "ok");
    emit({ type: "password_changed", result: "succes", userId, sessionId, ip, userAgent: userAgent ?? null });
    emit({ type: "session_revoked", result: "succes", userId, sessionId, ip, userAgent: userAgent ?? null });
    return "ok";
  }

  async function issueProvisional(userId: string, at: Date): Promise<string> {
    const password = provisionalPassword();
    const assessed = assessPassword(password, Math.max(deps.minLength, 20));
    if (!assessed.ok) {
      throw new Error("mot de passe refusé");
    }
    const hashed = await hashPassword(assessed.password, deps.argon);
    await setPassword(deps.pool, userId, hashed);
    await deleteVerification(deps.pool, tempHmac(key, userId));
    const marker = createHash("sha256").update(randomBytes(32)).digest("hex");
    await insertVerification(deps.pool, tempHmac(key, userId), marker, new Date(at.getTime() + TEMP_TTL_MS));
    await insertAudit(deps.pool, userId, "password_reset_used", "ok");
    return assessed.password;
  }

  async function createUser(identifier: string, ip: string): Promise<{ password: string; userId: string }> {
    const normalized = identifier.normalize("NFC").trim().toLowerCase();
    if (normalized.length === 0 || normalized.length > 320) {
      throw new Error("requête invalide");
    }
    if ((await countUsers(deps.pool)) > 0) {
      throw new Error("un seul compte");
    }
    const userId = await insertUser(deps.pool);
    const placeholder = await hashPassword(provisionalPassword(), deps.argon);
    await insertAccount(deps.pool, userId, normalized, placeholder);
    const password = await issueProvisional(userId, deps.now());
    emit({ type: "admin_action", result: "succes", userId, ip, userAgent: null });
    return { password, userId };
  }

  async function resetPassword(identifier: string, ip: string): Promise<string> {
    const normalized = identifier.normalize("NFC").trim().toLowerCase();
    if (normalized.length === 0 || normalized.length > 320) {
      throw new Error("requête invalide");
    }
    const account = await findAccount(deps.pool, normalized);
    if (account === null) {
      throw new Error("compte introuvable");
    }
    const now = deps.now();
    await revokeAllSessions(deps.pool, account.user_id, now);
    const password = await issueProvisional(account.user_id, now);
    emit({ type: "admin_action", result: "succes", userId: account.user_id, ip, userAgent: null });
    emit({ type: "password_reset_used", result: "succes", userId: account.user_id, ip, userAgent: null });
    return password;
  }

  return {
    signIn,
    resolve,
    signOut,
    changePassword,
    createUser,
    resetPassword,
    async profile(userId: string): Promise<{ id: string; role: string; identifier: string } | null> {
      const account = await findAccountByUser(deps.pool, userId);
      if (account === null) {
        return null;
      }
      return { id: account.user_id, role: account.role, identifier: account.identifier };
    },
    async devices(userId: string, currentSessionId: string) {
      const rows = await listDevices(deps.pool, userId, deps.now());
      return rows.map((row) => ({
        id: row.id,
        browser: row.browser,
        os: row.os,
        lastActivity: row.last_activity_at.toISOString(),
        current: row.id === currentSessionId,
      }));
    },
    listDocuments: (userId: string) => listDocuments(deps.pool, userId),
    deleteDocument: (userId: string, documentId: string) => deleteDocument(deps.pool, userId, documentId),
    argon: deps.argon,
    target: ARGON_TARGET,
  };
}
