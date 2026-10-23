/**
 * Réglages D-008 : profil, sessions et révocation.
 * Les lectures et mutations passent par le client T-013 (cookie, JSON, CSRF).
 * Aucune adresse IP ni donnée de lieu n'est conservée pour l'affichage.
 */
import {
  AUTH_PATHS,
  failureKind,
  normalizeIdentifier,
  type AuthClient,
  type FailureKind,
  type PasswordChange,
} from "../api.ts";
import { messages } from "./messages.fr.ts";

export const SESSIONS_PATH = "/api/v1/me/sessions";

const UUID =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

export type DeviceType = "desktop" | "tablet" | "phone" | null;

export type AccountSession = {
  id: string;
  current: boolean;
  deviceType: DeviceType;
  browser: string;
  os: string;
  lastActivity: string;
};

export type SessionView = {
  id: string;
  current: boolean;
  typeLabel: string;
  browser: string;
  os: string;
  lastActivity: string;
};

export type AccountNotice =
  | null
  | "unauthorized"
  | "reauth"
  | "mfa"
  | "not_found"
  | "forbidden"
  | "network"
  | "server"
  | "rejected"
  | "current_password"
  | "reauth_failed"
  | "invalid"
  | "limited"
  | "password_saved"
  | "revoked"
  | "others_revoked";

export type AccountPhase = "loading" | "ready" | "blocked" | "signed_out";

export type AccountState = {
  phase: AccountPhase;
  mfaEnrolled: boolean;
  timeZone: string;
  sessions: AccountSession[];
  sessionsKnown: boolean;
  notice: AccountNotice;
  pending: boolean;
  reauth: boolean;
};

export type AccountAction =
  | { type: "pending" }
  | {
      type: "loaded";
      blocked: boolean;
      mfaEnrolled: boolean;
      timeZone: string;
      sessions: AccountSession[];
      notice: AccountNotice;
    }
  | { type: "notice"; notice: AccountNotice; reauth?: boolean }
  | { type: "need_reauth" }
  | { type: "sessions"; sessions: AccountSession[]; notice: AccountNotice }
  | { type: "signed_out" };

export type ReauthInput = {
  identifier: string;
  password: string;
  totp: string;
  totpRequired: boolean;
  remember: boolean;
};

export const initialAccountState: AccountState = {
  phase: "loading",
  mfaEnrolled: false,
  timeZone: "UTC",
  sessions: [],
  sessionsKnown: false,
  notice: null,
  pending: false,
  reauth: false,
};

type CallResult = { ok: true; status: number; data: unknown } | { ok: false; kind: AccountNotice };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function problemOf(value: unknown): { code: string | null; detail: string | null; type: string | null } {
  const record = asRecord(value);
  if (record === null) {
    return { code: null, detail: null, type: null };
  }
  return {
    code: typeof record.code === "string" ? record.code : null,
    detail: typeof record.detail === "string" ? record.detail : null,
    type: typeof record.type === "string" ? record.type : null,
  };
}

export function classifySessionStatus(status: number, payload: unknown): AccountNotice {
  const problem = problemOf(payload);
  if (problem.code === "reauth_required" || (problem.type !== null && problem.type.endsWith("/reauth_required"))) {
    return "reauth";
  }
  if (problem.code === "mfa_required" || problem.detail === "code d'authentification requis") {
    return "mfa";
  }
  if (status === 401) {
    return "unauthorized";
  }
  if (status === 404) {
    return "not_found";
  }
  if (status === 403) {
    return "forbidden";
  }
  if (status === 429) {
    return "limited";
  }
  if (status === 400) {
    return "invalid";
  }
  return "server";
}

function noticeFromAuthKind(kind: FailureKind): AccountNotice {
  switch (kind) {
    case "unauthorized":
      return "unauthorized";
    case "mfa_required":
      return "mfa";
    case "forbidden":
      return "forbidden";
    case "invalid":
      return "invalid";
    case "limited":
      return "limited";
    case "rejected":
      return "rejected";
    case "network":
      return "network";
    case "server":
      return "server";
  }
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

async function call(client: AuthClient, method: string, path: string, body?: unknown): Promise<CallResult> {
  try {
    const response = await client.fetch(path, body === undefined ? { method } : { method, body });
    const data = await readPayload(response);
    if (response.ok) {
      return { ok: true, status: response.status, data };
    }
    return { ok: false, kind: classifySessionStatus(response.status, data) };
  } catch {
    return { ok: false, kind: "network" };
  }
}

export function activityZone(timeZone: string): string {
  if (timeZone === "UTC") {
    return "UTC";
  }
  try {
    new Intl.DateTimeFormat("fr-FR", { timeZone }).format();
    return timeZone;
  } catch {
    return "UTC";
  }
}

export function formatActivity(iso: string, timeZone: string): string | null {
  if (!ISO_TIME.test(iso)) {
    return null;
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const parts = new Intl.DateTimeFormat("fr-FR", {
    timeZone: activityZone(timeZone),
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  const day = pick("day");
  const month = pick("month");
  const year = pick("year");
  const hour = pick("hour");
  const minute = pick("minute");
  if (day === undefined || month === undefined || year === undefined || hour === undefined || minute === undefined) {
    return null;
  }
  return `${day}/${month}/${year} ${hour}:${minute}`;
}

function looksLikeAddress(value: string): boolean {
  if (/(?:\d{1,3}\.){3}\d{1,3}/.test(value)) {
    return true;
  }
  if (/[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,}/i.test(value)) {
    return true;
  }
  return /^-?\d{1,3}\.\d+,\s*-?\d{1,3}\.\d+$/.test(value);
}

function cleanLabel(value: string): string | null {
  let text = "";
  for (const char of value.normalize("NFC")) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) {
      continue;
    }
    text += char;
  }
  text = text.trim();
  if (text.length === 0 || text.length > 64) {
    return null;
  }
  if (/[<>]/.test(text) || /mailto:/i.test(text) || /javascript:/i.test(text) || looksLikeAddress(text)) {
    return null;
  }
  return text;
}

function splitLabel(label: string): { browser: string; os: string } | null {
  const parts = label.split(" · ");
  if (parts.length !== 2) {
    return null;
  }
  const browser = cleanLabel(parts[0] ?? "");
  const os = cleanLabel(parts[1] ?? "");
  if (browser === null || os === null) {
    return null;
  }
  return { browser, os };
}

function deviceTypeOf(value: unknown): DeviceType {
  if (value === "desktop" || value === "tablet" || value === "phone") {
    return value;
  }
  return null;
}

function activityOf(record: Record<string, unknown>): string | null {
  for (const candidate of [record.lastActivity, record.lastSeenAt]) {
    if (typeof candidate === "string" && formatActivity(candidate, "UTC") !== null) {
      return candidate;
    }
  }
  return null;
}

function labelsOf(record: Record<string, unknown>): { browser: string; os: string } {
  const browser = typeof record.browser === "string" ? cleanLabel(record.browser) : null;
  const os = typeof record.os === "string" ? cleanLabel(record.os) : null;
  if (browser !== null && os !== null) {
    return { browser, os };
  }
  if (typeof record.deviceLabel === "string") {
    const split = splitLabel(record.deviceLabel);
    if (split !== null) {
      return { browser: browser ?? split.browser, os: os ?? split.os };
    }
  }
  return {
    browser: browser ?? messages.unknownValue,
    os: os ?? messages.unknownValue,
  };
}

function parseSession(value: unknown): AccountSession | null {
  const record = asRecord(value);
  if (record === null || typeof record.id !== "string" || !UUID.test(record.id) || typeof record.current !== "boolean") {
    return null;
  }
  const lastActivity = activityOf(record);
  if (lastActivity === null) {
    return null;
  }
  const labels = labelsOf(record);
  return {
    id: record.id,
    current: record.current,
    deviceType: deviceTypeOf(record.deviceType),
    browser: labels.browser,
    os: labels.os,
    lastActivity,
  };
}

export function parseSessions(payload: unknown): AccountSession[] | null {
  if (!Array.isArray(payload)) {
    return null;
  }
  const sessions: AccountSession[] = [];
  for (const item of payload) {
    const session = parseSession(item);
    if (session !== null) {
      sessions.push(session);
    }
  }
  return sessions;
}

export function sessionView(session: AccountSession, timeZone: string): SessionView {
  const typeLabel =
    session.deviceType === null ? messages.deviceType.unknown : messages.deviceType[session.deviceType];
  return {
    id: session.id,
    current: session.current,
    typeLabel,
    browser: session.browser,
    os: session.os,
    lastActivity: formatActivity(session.lastActivity, timeZone) ?? messages.activityUnknown,
  };
}

export function sessionPath(sessionId: string): string | null {
  if (!UUID.test(sessionId)) {
    return null;
  }
  return `${SESSIONS_PATH}/${encodeURIComponent(sessionId)}`;
}

export async function listSessions(
  client: AuthClient,
): Promise<{ ok: true; sessions: AccountSession[] } | { ok: false; kind: AccountNotice }> {
  const result = await call(client, "GET", SESSIONS_PATH);
  if (!result.ok) {
    return result;
  }
  const sessions = parseSessions(result.data);
  if (sessions === null) {
    return { ok: false, kind: "server" };
  }
  return { ok: true, sessions };
}

export async function loadAccount(client: AuthClient): Promise<{
  profile: { email: string; mfaEnrolled: boolean; timeZone: string } | null;
  sessions: AccountSession[];
  notice: AccountNotice;
}> {
  const me = await client.me();
  if (!me.ok) {
    return { profile: null, sessions: [], notice: noticeFromAuthKind(me.kind) };
  }
  const listed = await listSessions(client);
  if (!listed.ok) {
    return {
      profile: { email: me.data.email, mfaEnrolled: me.data.mfaEnrolled, timeZone: me.data.timeZone },
      sessions: [],
      notice: listed.kind,
    };
  }
  return {
    profile: { email: me.data.email, mfaEnrolled: me.data.mfaEnrolled, timeZone: me.data.timeZone },
    sessions: listed.sessions,
    notice: null,
  };
}

async function deleteSession(client: AuthClient, sessionId: string): Promise<{ ok: true } | { ok: false; kind: AccountNotice }> {
  const path = sessionPath(sessionId);
  if (path === null) {
    return { ok: false, kind: "invalid" };
  }
  const result = await call(client, "DELETE", path);
  if (!result.ok) {
    return result;
  }
  if (result.status !== 204) {
    return { ok: false, kind: "server" };
  }
  return { ok: true };
}

export async function disconnectDevice(
  client: AuthClient,
  session: AccountSession,
): Promise<
  | { ok: true; signedOut: true }
  | { ok: true; signedOut: false; sessions: AccountSession[] }
  | { ok: false; kind: AccountNotice; sessions?: AccountSession[] }
> {
  if (session.current) {
    const result = await client.signOut();
    if (!result.ok) {
      return { ok: false, kind: noticeFromAuthKind(result.kind) };
    }
    return { ok: true, signedOut: true };
  }
  const removed = await deleteSession(client, session.id);
  if (!removed.ok) {
    if (removed.kind === "not_found") {
      const listed = await listSessions(client);
      if (listed.ok) {
        return { ok: false, kind: "not_found", sessions: listed.sessions };
      }
    }
    return removed;
  }
  const listed = await listSessions(client);
  if (!listed.ok) {
    return listed;
  }
  return { ok: true, signedOut: false, sessions: listed.sessions };
}

export async function disconnectOthers(
  client: AuthClient,
): Promise<{ ok: true; sessions: AccountSession[] } | { ok: false; kind: AccountNotice }> {
  const result = await call(client, "DELETE", SESSIONS_PATH);
  if (!result.ok) {
    return result;
  }
  if (result.status !== 204) {
    return { ok: false, kind: "server" };
  }
  const listed = await listSessions(client);
  if (!listed.ok) {
    return listed;
  }
  return { ok: true, sessions: listed.sessions };
}

export async function reauthenticate(
  client: AuthClient,
  input: ReauthInput,
): Promise<{ ok: true } | { ok: false; kind: AccountNotice }> {
  const identifier = normalizeIdentifier(input.identifier);
  if (identifier === null || input.password.length === 0) {
    return { ok: false, kind: "invalid" };
  }
  if (input.totpRequired && !/^\d{6}$/.test(input.totp)) {
    return { ok: false, kind: "invalid" };
  }
  const body: { identifier: string; password: string; remember?: boolean; totp?: string } = {
    identifier,
    password: input.password.normalize("NFC"),
  };
  if (input.remember) {
    body.remember = true;
  }
  if (input.totpRequired) {
    body.totp = input.totp;
  }
  let response: Response;
  try {
    response = await client.fetch(AUTH_PATHS.signIn, { method: "POST", body });
  } catch {
    return { ok: false, kind: "network" };
  }
  const data = await readPayload(response);
  if (!response.ok) {
    const kind = noticeFromAuthKind(failureKind(response.status, data));
    if (kind === "unauthorized") {
      return { ok: false, kind: "reauth_failed" };
    }
    return { ok: false, kind };
  }
  const record = asRecord(data);
  if (record === null || typeof record.id !== "string" || record.id.length === 0 || typeof record.identifier !== "string") {
    return { ok: false, kind: "server" };
  }
  return { ok: true };
}

export async function reauthAndDisconnectOthers(
  client: AuthClient,
  input: ReauthInput,
): Promise<{ ok: true; sessions: AccountSession[] } | { ok: false; kind: AccountNotice }> {
  const signed = await reauthenticate(client, input);
  if (!signed.ok) {
    return signed;
  }
  return disconnectOthers(client);
}

export async function savePassword(
  client: AuthClient,
  value: PasswordChange,
): Promise<{ ok: true; sessions: AccountSession[] } | { ok: false; kind: AccountNotice }> {
  const changed = await client.changePassword(value);
  if (!changed.ok) {
    return { ok: false, kind: changed.kind === "unauthorized" ? "current_password" : noticeFromAuthKind(changed.kind) };
  }
  const listed = await listSessions(client);
  if (!listed.ok) {
    return listed;
  }
  return { ok: true, sessions: listed.sessions };
}

function blocked(state: AccountState, notice: AccountNotice): AccountState {
  return {
    ...state,
    phase: "blocked",
    pending: false,
    mfaEnrolled: false,
    timeZone: "UTC",
    sessions: [],
    sessionsKnown: false,
    notice,
    reauth: false,
  };
}

export function reduceAccount(state: AccountState, action: AccountAction): AccountState {
  switch (action.type) {
    case "pending":
      return state.pending ? state : { ...state, pending: true };
    case "loaded":
      if (action.blocked) {
        return blocked(state, action.notice ?? "server");
      }
      return {
        ...state,
        phase: "ready",
        pending: false,
        mfaEnrolled: action.mfaEnrolled,
        timeZone: activityZone(action.timeZone),
        sessions: action.sessions,
        sessionsKnown: action.notice === null,
        notice: action.notice,
        reauth: action.notice === "reauth",
      };
    case "notice":
      if (action.notice === "unauthorized" || action.notice === "mfa") {
        return blocked(state, action.notice);
      }
      return {
        ...state,
        pending: false,
        notice: action.notice,
        reauth: action.reauth ?? state.reauth,
      };
    case "need_reauth":
      return { ...state, pending: false, reauth: true, notice: "reauth" };
    case "sessions":
      return {
        ...state,
        phase: "ready",
        pending: false,
        sessions: action.sessions,
        sessionsKnown: true,
        notice: action.notice,
        reauth: false,
      };
    case "signed_out":
      return { ...initialAccountState, phase: "signed_out", pending: false };
  }
}
