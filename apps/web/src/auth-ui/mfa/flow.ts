/**
 * Appels MFA via le client partagé (T-013). Ce module ne le modifie pas :
 * sign-in reçoit totp ou recoveryCode par fetch, enroll et verify aussi.
 * L'enrôlement initial est mis en cache par client : un second POST
 * refuserait et la clé déjà émise ne serait plus affichable.
 */
import { AUTH_PATHS, failureKind, normalizeIdentifier, type AuthClient, type AuthResult, type Credentials, type FailureKind } from "../api.ts";
import { IDENTIFIER_MAX_LENGTH } from "../policy.ts";

import type { EnrollmentBundle, MfaNotice } from "./phase.ts";
import { noticeFromKind } from "./phase.ts";
import { RECOVERY_CODE_COUNT, formatRecoveryCode, formatSecret, formatTotp, otpauthUri } from "./policy.ts";

export const MFA_PATHS = {
  enroll: "/api/auth/mfa/enroll",
  verify: "/api/auth/mfa/verify",
} as const;

export type FactorOutcome = { ok: true } | { ok: false; notice: MfaNotice };
export type EnrollmentOutcome = { ok: true; enrollment: EnrollmentBundle } | { ok: false; notice: MfaNotice };

const initialEnrollments = new WeakMap<AuthClient, Promise<EnrollmentOutcome>>();

function failure(kind: FailureKind, status = 0): AuthResult<unknown> {
  return { ok: false, status, kind, retryAfter: null };
}

function parseRetryAfter(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 0) {
    return null;
  }
  return seconds;
}

async function readPayload(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return null;
  }
  const text = await response.text();
  if (text.trim() === "") {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

async function exchange(response: Response): Promise<AuthResult<unknown>> {
  const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
  const data = await readPayload(response);
  if (response.ok) {
    return { ok: true, status: response.status, data };
  }
  return { ok: false, status: response.status, kind: failureKind(response.status, data), retryAfter };
}

async function post(client: AuthClient, path: string, body: unknown): Promise<AuthResult<unknown>> {
  try {
    const response = await client.fetch(path, { method: "POST", body });
    return await exchange(response);
  } catch {
    return failure("network");
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function noticeOf(result: AuthResult<unknown>): MfaNotice {
  if (result.ok) {
    return "server";
  }
  return noticeFromKind(result.kind);
}

function cleanLabel(raw: string): string {
  const kept: string[] = [];
  for (const char of raw.normalize("NFC")) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) {
      continue;
    }
    kept.push(char);
  }
  return Array.from(kept.join("").trim()).slice(0, IDENTIFIER_MAX_LENGTH).join("");
}

export function enrollmentAccount(
  explicit: string | undefined,
  credentials: Credentials | undefined,
  fallback: string,
): string {
  if (explicit !== undefined) {
    const cleaned = cleanLabel(explicit);
    if (cleaned.length > 0) {
      return cleaned;
    }
  }
  if (credentials !== undefined) {
    const identifier = normalizeIdentifier(credentials.identifier);
    if (identifier !== null) {
      return identifier;
    }
  }
  return cleanLabel(fallback);
}

type SignInBody = {
  identifier: string;
  password: string;
  remember?: true;
  totp?: string;
  recoveryCode?: string;
};

function signInBody(credentials: Credentials, factor: { totp: string } | { recoveryCode: string }): SignInBody | null {
  const identifier = normalizeIdentifier(credentials.identifier);
  if (identifier === null || credentials.password.length === 0) {
    return null;
  }
  const body: SignInBody = {
    identifier,
    password: credentials.password.normalize("NFC"),
  };
  if (credentials.remember) {
    body.remember = true;
  }
  if ("totp" in factor) {
    body.totp = factor.totp;
  } else {
    body.recoveryCode = factor.recoveryCode;
  }
  return body;
}

function acceptedSession(result: AuthResult<unknown>): boolean {
  if (!result.ok) {
    return false;
  }
  const record = asRecord(result.data);
  return record !== null && typeof record.id === "string" && record.id.length > 0 && typeof record.identifier === "string" && record.identifier.length > 0;
}

async function submitFactor(
  client: AuthClient,
  credentials: Credentials | undefined,
  factor: { totp: string } | { recoveryCode: string },
): Promise<FactorOutcome> {
  if (credentials === undefined) {
    return { ok: false, notice: "invalid" };
  }
  const body = signInBody(credentials, factor);
  if (body === null) {
    return { ok: false, notice: "invalid" };
  }
  const result = await post(client, AUTH_PATHS.signIn, body);
  if (!result.ok) {
    return { ok: false, notice: noticeOf(result) };
  }
  if (!acceptedSession(result)) {
    return { ok: false, notice: "server" };
  }
  return { ok: true };
}

export async function submitTotpCode(
  client: AuthClient,
  credentials: Credentials | undefined,
  raw: string,
): Promise<FactorOutcome> {
  const totp = formatTotp(raw);
  if (totp === null) {
    return { ok: false, notice: "format" };
  }
  return submitFactor(client, credentials, { totp });
}

export async function submitRecoveryCode(
  client: AuthClient,
  credentials: Credentials | undefined,
  raw: string,
): Promise<FactorOutcome> {
  const recoveryCode = formatRecoveryCode(raw);
  if (recoveryCode === null) {
    return { ok: false, notice: "format" };
  }
  return submitFactor(client, credentials, { recoveryCode });
}

function bundleFrom(data: unknown, issuer: string, accountLabel: string): EnrollmentBundle | null {
  const record = asRecord(data);
  if (record === null || typeof record.secret !== "string" || !Array.isArray(record.codes)) {
    return null;
  }
  const secret = formatSecret(record.secret);
  if (secret === null || record.codes.length !== RECOVERY_CODE_COUNT) {
    return null;
  }
  const codes: string[] = [];
  for (const item of record.codes) {
    if (typeof item !== "string") {
      return null;
    }
    const code = formatRecoveryCode(item);
    if (code === null) {
      return null;
    }
    codes.push(code);
  }
  if (new Set(codes).size !== RECOVERY_CODE_COUNT) {
    return null;
  }
  const otpauth = otpauthUri(secret, accountLabel, issuer);
  if (otpauth === null) {
    return null;
  }
  return { secret, otpauth, codes };
}

async function postEnrollment(client: AuthClient, accountLabel: string, issuer: string): Promise<EnrollmentOutcome> {
  const result = await post(client, MFA_PATHS.enroll, {});
  if (!result.ok) {
    return { ok: false, notice: noticeOf(result) };
  }
  const enrollment = bundleFrom(result.data, issuer, accountLabel);
  if (enrollment === null) {
    return { ok: false, notice: "server" };
  }
  return { ok: true, enrollment };
}

/** Un seul POST /api/auth/mfa/enroll par client tant que le succès est en mémoire. */
export function enrollOnce(client: AuthClient, accountLabel: string, issuer: string): Promise<EnrollmentOutcome> {
  const existing = initialEnrollments.get(client);
  if (existing !== undefined) {
    return existing;
  }
  const promise = postEnrollment(client, accountLabel, issuer).then(
    (outcome) => {
      if (!outcome.ok) {
        initialEnrollments.delete(client);
      }
      return outcome;
    },
    (error: unknown) => {
      initialEnrollments.delete(client);
      throw error;
    },
  );
  initialEnrollments.set(client, promise);
  return promise;
}

/** Reconfiguration : nouvel appel, les anciens codes sont invalidés par le serveur. */
export function enrollFresh(client: AuthClient, accountLabel: string, issuer: string): Promise<EnrollmentOutcome> {
  initialEnrollments.delete(client);
  return postEnrollment(client, accountLabel, issuer);
}

export function dropEnrollment(client: AuthClient): void {
  initialEnrollments.delete(client);
}

export async function verifyEnrollmentCode(client: AuthClient, raw: string): Promise<FactorOutcome> {
  const code = formatTotp(raw);
  if (code === null) {
    return { ok: false, notice: "format" };
  }
  const result = await post(client, MFA_PATHS.verify, { code });
  if (!result.ok) {
    return { ok: false, notice: noticeOf(result) };
  }
  const record = asRecord(result.data);
  if (record?.ok !== true) {
    return { ok: false, notice: "server" };
  }
  dropEnrollment(client);
  return { ok: true };
}

export async function signOutOfEnrollment(client: AuthClient): Promise<FactorOutcome> {
  try {
    const result = await client.signOut();
    if (!result.ok) {
      return { ok: false, notice: noticeFromKind(result.kind) };
    }
    dropEnrollment(client);
    return { ok: true };
  } catch {
    return { ok: false, notice: "network" };
  }
}
