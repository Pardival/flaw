/**
 * Authentification par mot de passe et sessions opaques hachées.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";

import {
  COLUMN,
  dekResolvable,
  generateDek,
  openContent,
  sealContent,
  unwrapDek,
  wrapDek,
  type KeyStatus,
} from "@flaw/crypto";

import type { SecurityEvent } from "../platform/security-log.ts";
import { deviceLabel, summarizeDevice, type DeviceSummary } from "./device.ts";
import { hashSessionToken, newSessionToken } from "./cookie.ts";
import { bucketHmac, hmacKey, ipHmac, subjectHmac, tempHmac } from "./hmac.ts";
import { encodeBase32, matchTotp, recoveryCode, recoveryCodeHmac } from "./mfa.ts";
import { RESTRICTED_TTL_MS } from "./restricted-session.ts";
import {
  ARGON_TARGET,
  assessPassword,
  assertArgonParams,
  assertPasswordMinLength,
  dummyPasswordMaterial,
  hashPassword,
  passwordNeedsRehash,
  provisionalPassword,
  type ArgonParams,
} from "./password.ts";
import * as passwordApi from "./password.ts";
import {
  absentUserId,
  activeLock,
  bumpRate,
  countUsers,
  deleteBuckets,
  deleteDocument,
  deleteRecoveryCodes,
  deleteTotpFactors,
  deleteVerification,
  deleteVerificationsByValue,
  findAccount,
  findAccountByUser,
  findActiveUserKey,
  findSession,
  findSessionById,
  findTotpFactor,
  findUserKey,
  findVerification,
  findVerificationRow,
  insertAccount,
  insertAudit,
  insertAuthEvent,
  insertLock,
  insertRecoveryCode,
  insertSession,
  insertTotpFactor,
  insertUserKey,
  invalidateRecoveryCodes,
  liftRestriction,
  purgeRateLimits,
  recentRate,
  rotateSession,
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
  upsertVerification,
  consumeRecoveryCode,
  type SessionRow,
  type TotpFactorRow,
} from "./store.ts";

const WINDOW_MS = 15 * 60 * 1000;
const SLICE_MS = 60 * 1000;
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
  kek?: Uint8Array;
  kekId?: string;
  recoveryPepper?: Uint8Array;
  recoveryPepperId?: string;
};

export type SignInResult =
  | {
      kind: "ok";
      token: string;
      maxAge: number | null;
      userId: string;
      identifier: string;
      sessionId: string;
      restricted: boolean;
    }
  | { kind: "invalid" }
  | { kind: "mfa" }
  | { kind: "limited"; retryAfter: number };

type AttemptContext = {
  identifier: string;
  password: string;
  ip: string;
  userAgent: string | undefined;
  remember: boolean;
  totp?: string;
  recoveryCode?: string;
};

function sliceStart(now: Date): Date {
  return new Date(Math.floor(now.getTime() / SLICE_MS) * SLICE_MS);
}

function windowSince(now: Date): Date {
  return new Date(now.getTime() - WINDOW_MS);
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
  const dummy = hashPassword(dummyPasswordMaterial(), deps.argon);
  const readyPromise = dummy.then(() => undefined);

  function ready(): Promise<void> {
    return readyPromise;
  }

  function dummyHash(): Promise<string> {
    return dummy;
  }

  function emit(event: SecurityEvent): void {
    deps.onEvent?.(event);
  }

  async function checkSecret(password: string, hashed: string | null): Promise<boolean> {
    const material = hashed !== null && hashed.startsWith("$argon2id$") ? hashed : await dummyHash();
    const matches = await passwordApi.verifyPassword(password, material);
    return hashed !== null && hashed.startsWith("$argon2id$") && matches;
  }

  async function signIn(input: AttemptContext): Promise<SignInResult> {
    const now = deps.now();
    const device = summarizeDevice(input.userAgent);
    const summary = deviceLabel(device);
    const ipHit = await noteHit(bucketHmac(key, `ip|${input.ip}`), now);
    if (ipHit.hits > 20) {
      await insertAuthEvent(
        deps.pool,
        "login_rate_limited",
        subjectHmac(key, input.identifier),
        ipHmac(key, input.ip),
        summary,
      );
      emit({ type: "rate_limited", result: "echec", ip: input.ip, userAgent: input.userAgent ?? null });
      return { kind: "limited", retryAfter: ipHit.retryAfter };
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
    const provisional = tempExpires !== null;
    if (provisional) {
      await clearFailures(input.identifier);
      return issueSession(account.user_id, input, now, true);
    }
    const factor = await findTotpFactor(deps.pool, account.user_id);
    if (factor !== null && !(await deviceIsTrusted(account.user_id, device, now))) {
      if (input.totp !== undefined && input.recoveryCode !== undefined) {
        return { kind: "invalid" };
      }
      if (input.recoveryCode !== undefined) {
        const consumed = await consumeRecovery(account.user_id, input.recoveryCode, now);
        if (!consumed) {
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
            userId: account.user_id,
            ip: input.ip,
            userAgent: input.userAgent ?? null,
          });
          return { kind: "invalid" };
        }
        await upsertVerification(deps.pool, reconfigureId(account.user_id), "1", new Date(now.getTime() + DAY_MS));
        await clearFailures(input.identifier);
        return issueSession(account.user_id, input, now, true);
      }
      if (input.totp === undefined) {
        return { kind: "mfa" };
      }
      const step = await acceptTotp(account.user_id, factor, input.totp, now);
      if (step === null) {
        await registerFailure(input.identifier, now);
        await insertAuthEvent(
          deps.pool,
          "login_failed",
          subjectHmac(key, input.identifier),
          ipHmac(key, input.ip),
          summary,
        );
        emit({
          type: "mfa_failed",
          result: "echec",
          userId: account.user_id,
          ip: input.ip,
          userAgent: input.userAgent ?? null,
        });
        return { kind: "invalid" };
      }
      await rememberStep(account.user_id, step, now);
      await trustDevice(account.user_id, device, now);
      await clearFailures(input.identifier);
      return issueSession(account.user_id, input, now, false);
    }
    await clearFailures(input.identifier);
    return issueSession(account.user_id, input, now, false);
  }

  async function noteHit(bucket: string, now: Date): Promise<{ hits: number; retryAfter: number }> {
    const since = windowSince(now);
    await purgeRateLimits(deps.pool, since);
    await bumpRate(deps.pool, bucket, sliceStart(now));
    const recent = await recentRate(deps.pool, bucket, since, now);
    const oldest = recent.oldest ?? sliceStart(now);
    return { hits: recent.hits, retryAfter: retrySeconds(new Date(oldest.getTime() + WINDOW_MS), now) };
  }

  async function registerFailure(identifier: string, now: Date): Promise<void> {
    const hit = await noteHit(bucketHmac(key, `acct-fail|${identifier}`), now);
    if (hit.hits < 5) {
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

  function ceiling(row: SessionRow): Date {
    if (!row.restricted) {
      return row.absolute_expires_at;
    }
    const cap = new Date(row.created_at.getTime() + RESTRICTED_TTL_MS);
    return cap < row.absolute_expires_at ? cap : row.absolute_expires_at;
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
    const absolute = ceiling(row);
    if (now.getTime() >= absolute.getTime() || now.getTime() >= row.expires_at.getTime()) {
      return null;
    }
    const idleMs = (row.remember ? deps.idleDays : 1) * DAY_MS;
    const nextIdle = new Date(now.getTime() + idleMs);
    const expires = nextIdle < absolute ? nextIdle : absolute;
    if (expires.getTime() <= now.getTime()) {
      return null;
    }
    await touchSession(deps.pool, row.id, now, expires);
    return row;
  }

  async function issueSession(
    userId: string,
    input: AttemptContext,
    now: Date,
    restricted: boolean,
  ): Promise<Extract<SignInResult, { kind: "ok" }>> {
    const device = summarizeDevice(input.userAgent);
    const bounds = restricted
      ? { idle: new Date(now.getTime() + RESTRICTED_TTL_MS), absolute: new Date(now.getTime() + RESTRICTED_TTL_MS) }
      : boundsFor(input.remember, now);
    const issued = newSessionToken();
    const sessionId = await insertSession(deps.pool, {
      userId,
      tokenHash: issued.hash,
      expiresAt: bounds.idle,
      absoluteExpiresAt: bounds.absolute,
      createdAt: now,
      browser: device.browser,
      os: device.os,
      remember: input.remember,
      restricted,
    });
    await insertAudit(deps.pool, userId, "login_success", "ok");
    emit({
      type: "login_success",
      result: "succes",
      userId,
      sessionId,
      ip: input.ip,
      userAgent: input.userAgent ?? null,
    });
    emit({
      type: "session_created",
      result: "succes",
      userId,
      sessionId,
      ip: input.ip,
      userAgent: input.userAgent ?? null,
    });
    return {
      kind: "ok",
      token: issued.token,
      maxAge: restricted ? RESTRICTED_TTL_MS / 1000 : input.remember ? deps.maxDays * 24 * 60 * 60 : null,
      userId,
      identifier: input.identifier,
      sessionId,
      restricted,
    };
  }

  async function clearFailures(identifier: string): Promise<void> {
    await deleteBuckets(deps.pool, [
      bucketHmac(key, `acct-fail|${identifier}`),
      bucketHmac(key, `acct-lock|${identifier}`),
    ]);
  }

  function deviceId(userId: string, device: DeviceSummary): string {
    return bucketHmac(key, `device|${userId}|${device.browser}|${device.os}`);
  }

  function stepId(userId: string): string {
    return bucketHmac(key, `totp-step|${userId}`);
  }

  function reconfigureId(userId: string): string {
    return bucketHmac(key, `reconfigure|${userId}`);
  }

  async function deviceIsTrusted(userId: string, device: DeviceSummary, now: Date): Promise<boolean> {
    const row = await findVerificationRow(deps.pool, deviceId(userId, device));
    return row !== null && row.value_hash === userId && now.getTime() < row.expires_at.getTime();
  }

  async function trustDevice(userId: string, device: DeviceSummary, now: Date): Promise<void> {
    await upsertVerification(deps.pool, deviceId(userId, device), userId, new Date(now.getTime() + 90 * DAY_MS));
  }

  async function rememberStep(userId: string, step: number, now: Date): Promise<void> {
    await upsertVerification(deps.pool, stepId(userId), String(step), new Date(now.getTime() + 90 * DAY_MS));
  }

  async function lastStep(userId: string): Promise<number | null> {
    const row = await findVerificationRow(deps.pool, stepId(userId));
    if (row === null) {
      return null;
    }
    const parsed = Number(row.value_hash);
    return Number.isInteger(parsed) ? parsed : null;
  }

  function openDek(userId: string, row: { wrapped_ct: Buffer; wrapped_nonce: Buffer; key_id: string; enc_version: number; status: string }): Uint8Array | null {
    if (deps.kek === undefined || !dekResolvable(row.status as KeyStatus)) {
      return null;
    }
    try {
      return unwrapDek(deps.kek, userId, {
        wrappedCt: new Uint8Array(row.wrapped_ct),
        wrappedNonce: new Uint8Array(row.wrapped_nonce),
        keyId: row.key_id,
        encVersion: row.enc_version,
        status: row.status as KeyStatus,
      });
    } catch {
      return null;
    }
  }

  async function readTotpSecret(userId: string, factor: TotpFactorRow): Promise<Uint8Array | null> {
    const keyRow = await findUserKey(deps.pool, userId, factor.key_id);
    if (keyRow === null) {
      return null;
    }
    const dek = openDek(userId, keyRow);
    if (dek === null) {
      return null;
    }
    try {
      return openContent(
        { ownerId: userId, rowId: factor.id, column: COLUMN.secretCt },
        {
          ciphertext: new Uint8Array(factor.secret_ct),
          nonce: new Uint8Array(factor.secret_nonce),
          keyId: factor.key_id,
          encVersion: factor.enc_version,
        },
        (ownerId, keyId) => (ownerId === userId && keyId === factor.key_id ? dek : undefined),
      );
    } catch {
      return null;
    } finally {
      dek.fill(0);
    }
  }

  async function acceptTotp(userId: string, factor: TotpFactorRow, code: string, now: Date): Promise<number | null> {
    const secret = await readTotpSecret(userId, factor);
    if (secret === null) {
      return null;
    }
    try {
      return matchTotp(secret, code, now, await lastStep(userId));
    } finally {
      secret.fill(0);
    }
  }

  async function consumeRecovery(userId: string, code: string, now: Date): Promise<boolean> {
    if (deps.recoveryPepper === undefined || deps.recoveryPepperId === undefined) {
      return false;
    }
    const mac = recoveryCodeHmac(deps.recoveryPepper, deps.recoveryPepperId, userId, code);
    if (mac === null) {
      return false;
    }
    return consumeRecoveryCode(deps.pool, userId, mac, now);
  }

  async function provisionalActive(userId: string, now: Date): Promise<boolean> {
    const expires = await findVerification(deps.pool, tempHmac(key, userId));
    return expires !== null && now.getTime() < expires.getTime();
  }

  async function reconfigureActive(userId: string, now: Date): Promise<boolean> {
    const row = await findVerificationRow(deps.pool, reconfigureId(userId));
    return row !== null && now.getTime() < row.expires_at.getTime();
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
  ): Promise<
    | { kind: "ok"; token: string; maxAge: number | null }
    | { kind: "invalid" }
    | { kind: "rejected" }
    | { kind: "limited"; retryAfter: number }
  > {
    const now = deps.now();
    const hit = await noteHit(bucketHmac(key, `pwd-change|${userId}`), now);
    if (hit.hits > 5) {
      emit({ type: "rate_limited", result: "echec", userId, sessionId, ip, userAgent: userAgent ?? null });
      return { kind: "limited", retryAfter: hit.retryAfter };
    }
    const account = await findAccountByUser(deps.pool, userId);
    if (account?.password_hash == null) {
      return { kind: "invalid" };
    }
    const current = currentPassword.normalize("NFC");
    const matches = await passwordApi.verifyPassword(current, account.password_hash);
    if (!matches) {
      return { kind: "invalid" };
    }
    const assessed = assessPassword(nextPassword, deps.minLength);
    if (!assessed.ok) {
      return { kind: "rejected" };
    }
    const hashed = await hashPassword(assessed.password, deps.argon);
    await setPassword(deps.pool, userId, hashed);
    await deleteVerification(deps.pool, tempHmac(key, userId));
    await revokeOtherSessions(deps.pool, userId, sessionId, now);
    const issued = newSessionToken();
    await rotateSession(deps.pool, sessionId, issued.hash, now);
    const currentSession = await findSession(deps.pool, issued.hash);
    await insertAudit(deps.pool, userId, "password_changed", "ok");
    emit({ type: "password_changed", result: "succes", userId, sessionId, ip, userAgent: userAgent ?? null });
    emit({ type: "session_revoked", result: "succes", userId, sessionId, ip, userAgent: userAgent ?? null });
    const restrictedLeft = currentSession?.restricted === true;
    const maxAge = restrictedLeft
      ? Math.max(
          1,
          Math.ceil(((currentSession?.created_at.getTime() ?? now.getTime()) + RESTRICTED_TTL_MS - now.getTime()) / 1000),
        )
      : currentSession?.remember === true
        ? deps.maxDays * 24 * 60 * 60
        : null;
    return {
      kind: "ok",
      token: issued.token,
      maxAge,
    };
  }

  async function forgetPassword(
    ip: string,
  ): Promise<{ kind: "ok" } | { kind: "limited"; retryAfter: number }> {
    const now = deps.now();
    const hit = await noteHit(bucketHmac(key, `forgot|${ip}`), now);
    if (hit.hits > 5) {
      emit({ type: "rate_limited", result: "echec", ip, userAgent: null });
      return { kind: "limited", retryAfter: hit.retryAfter };
    }
    return { kind: "ok" };
  }

  async function issueProvisional(userId: string, at: Date, chosen?: string): Promise<string> {
    const password = chosen ?? provisionalPassword();
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

  function requireIdentifier(identifier: string): string {
    const normalized = identifier.normalize("NFC").trim().toLowerCase();
    if (normalized.length === 0 || normalized.length > 320) {
      throw new Error("requête invalide");
    }
    return normalized;
  }

  function adminEmit(action: SecurityEvent["action"], userId: string, ip: string): void {
    emit({ type: "admin_action", result: "succes", userId, ip, userAgent: null, action });
  }

  async function createUser(
    identifier: string,
    ip: string,
    chosen?: string,
  ): Promise<{ password: string; userId: string }> {
    const normalized = requireIdentifier(identifier);
    if ((await countUsers(deps.pool)) > 0) {
      throw new Error("un seul compte");
    }
    const userId = await insertUser(deps.pool);
    const placeholder = await hashPassword(provisionalPassword(), deps.argon);
    await insertAccount(deps.pool, userId, normalized, placeholder);
    const password = await issueProvisional(userId, deps.now(), chosen);
    await insertAudit(deps.pool, userId, "admin.create_user", "ok");
    adminEmit("admin.create_user", userId, ip);
    return { password, userId };
  }

  async function resetPassword(identifier: string, ip: string, chosen?: string): Promise<string> {
    const normalized = requireIdentifier(identifier);
    const account = await findAccount(deps.pool, normalized);
    if (account === null) {
      throw new Error("compte introuvable");
    }
    const now = deps.now();
    await revokeAllSessions(deps.pool, account.user_id, now);
    await deleteVerificationsByValue(deps.pool, account.user_id);
    await deleteVerification(deps.pool, reconfigureId(account.user_id));
    const password = await issueProvisional(account.user_id, now, chosen);
    await insertAudit(deps.pool, account.user_id, "admin.reset_password", "ok");
    adminEmit("admin.reset_password", account.user_id, ip);
    emit({ type: "password_reset_used", result: "succes", userId: account.user_id, ip, userAgent: null });
    return password;
  }

  async function disableMfa(identifier: string, ip: string, chosen?: string): Promise<string> {
    const normalized = requireIdentifier(identifier);
    const account = await findAccount(deps.pool, normalized);
    if (account === null) {
      throw new Error("compte introuvable");
    }
    const now = deps.now();
    await revokeAllSessions(deps.pool, account.user_id, now);
    await deleteTotpFactors(deps.pool, account.user_id);
    await deleteRecoveryCodes(deps.pool, account.user_id);
    await deleteVerificationsByValue(deps.pool, account.user_id);
    await deleteVerification(deps.pool, stepId(account.user_id));
    await deleteVerification(deps.pool, reconfigureId(account.user_id));
    const password = await issueProvisional(account.user_id, now, chosen);
    await insertAudit(deps.pool, account.user_id, "admin.disable_mfa", "ok");
    adminEmit("admin.disable_mfa", account.user_id, ip);
    emit({ type: "mfa_disabled", result: "succes", userId: account.user_id, ip, userAgent: null });
    return password;
  }

  async function revokeSessions(identifier: string, ip: string): Promise<void> {
    const normalized = requireIdentifier(identifier);
    const account = await findAccount(deps.pool, normalized);
    if (account === null) {
      throw new Error("compte introuvable");
    }
    await revokeAllSessions(deps.pool, account.user_id, deps.now());
    await insertAudit(deps.pool, account.user_id, "admin.revoke_sessions", "ok");
    adminEmit("admin.revoke_sessions", account.user_id, ip);
    emit({ type: "session_revoked", result: "succes", userId: account.user_id, ip, userAgent: null });
  }

  async function enroll(
    userId: string,
    restricted: boolean,
  ): Promise<{ kind: "ok"; secret: string; codes: string[] } | { kind: "forbidden" }> {
    const kek = deps.kek;
    const kekId = deps.kekId;
    const recoveryPepper = deps.recoveryPepper;
    const recoveryPepperId = deps.recoveryPepperId;
    if (!restricted || kek === undefined || kekId === undefined || recoveryPepper === undefined || recoveryPepperId === undefined) {
      return { kind: "forbidden" };
    }
    const now = deps.now();
    if (await provisionalActive(userId, now)) {
      return { kind: "forbidden" };
    }
    const existing = await findTotpFactor(deps.pool, userId);
    const reconfigure = await reconfigureActive(userId, now);
    if (existing !== null && !reconfigure) {
      return { kind: "forbidden" };
    }
    const secret = randomBytes(20);
    let dek: Uint8Array | undefined;
    const client = await deps.pool.connect();
    try {
      await client.query("BEGIN");
      if (reconfigure) {
        await deleteTotpFactors(client, userId);
        await invalidateRecoveryCodes(client, userId, now);
        await deleteVerification(client, stepId(userId));
        await deleteVerification(client, reconfigureId(userId));
      }
      const active = await findActiveUserKey(client, userId);
      let dekId: string;
      if (active !== null) {
        const opened = openDek(userId, active);
        if (opened === null) {
          await client.query("ROLLBACK");
          return { kind: "forbidden" };
        }
        dek = opened;
        dekId = active.id;
      } else {
        dek = generateDek();
        dekId = randomUUID();
        const wrapped = wrapDek(kek, kekId, userId, dek);
        await insertUserKey(client, {
          id: dekId,
          userId,
          wrappedCt: wrapped.wrappedCt,
          wrappedNonce: wrapped.wrappedNonce,
          kekId,
          encVersion: wrapped.encVersion,
        });
      }
      const factorId = randomUUID();
      const sealed = sealContent(dek, dekId, { ownerId: userId, rowId: factorId, column: COLUMN.secretCt }, secret);
      await insertTotpFactor(client, {
        id: factorId,
        userId,
        secretCt: sealed.ciphertext,
        secretNonce: sealed.nonce,
        dekId,
        encVersion: sealed.encVersion,
      });
      const codes: string[] = [];
      for (let index = 0; index < 10; index += 1) {
        const code = recoveryCode();
        const mac = recoveryCodeHmac(recoveryPepper, recoveryPepperId, userId, code);
        if (mac === null) {
          throw new Error("code refusé");
        }
        await insertRecoveryCode(client, userId, recoveryPepperId, mac);
        codes.push(code);
      }
      await insertAudit(client, userId, "mfa_enabled", "ok");
      await client.query("COMMIT");
      emit({ type: "mfa_enabled", result: "succes", userId, ip: null, userAgent: null });
      return { kind: "ok", secret: encodeBase32(secret), codes };
    } catch {
      await client.query("ROLLBACK");
      return { kind: "forbidden" };
    } finally {
      secret.fill(0);
      dek?.fill(0);
      client.release();
    }
  }

  async function verifyMfa(
    userId: string,
    sessionId: string,
    code: string,
    userAgent: string | undefined,
  ): Promise<{ kind: "ok"; maxAge: number | null } | { kind: "invalid" } | { kind: "forbidden" }> {
    const session = await findSessionById(deps.pool, sessionId);
    if (session === null || !session.restricted || session.revoked_at !== null) {
      return { kind: "forbidden" };
    }
    const now = deps.now();
    if ((await provisionalActive(userId, now)) || (await reconfigureActive(userId, now))) {
      return { kind: "forbidden" };
    }
    const factor = await findTotpFactor(deps.pool, userId);
    if (factor === null) {
      return { kind: "forbidden" };
    }
    const step = await acceptTotp(userId, factor, code, now);
    if (step === null) {
      emit({ type: "mfa_failed", result: "echec", userId, sessionId, ip: null, userAgent: userAgent ?? null });
      return { kind: "invalid" };
    }
    await rememberStep(userId, step, now);
    await trustDevice(userId, summarizeDevice(userAgent), now);
    const bounds = boundsFor(session.remember, now);
    await liftRestriction(deps.pool, sessionId, now, bounds.idle, bounds.absolute);
    return {
      kind: "ok",
      maxAge: session.remember ? deps.maxDays * 24 * 60 * 60 : null,
    };
  }

  return {
    ready,
    signIn,
    resolve,
    signOut,
    changePassword,
    forgetPassword,
    createUser,
    resetPassword,
    disableMfa,
    revokeSessions,
    enroll,
    verifyMfa,
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
