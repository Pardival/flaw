/**
 * Journal de sécurité structuré (SEC-LOG-01) avec masquage centralisé (SEC-LOG-02).
 * Seuls les champs autorisés sont écrits. Le corps, le titre, les secrets et les
 * en-têtes Authorization / Cookie ne font pas partie de l'enregistrement.
 */
import { createHash } from "node:crypto";
import { type Writable } from "node:stream";

export const SECURITY_EVENTS = [
  "login_success",
  "login_failure",
  "rate_limited",
  "mfa_enabled",
  "mfa_failed",
  "mfa_disabled",
  "password_changed",
  "session_created",
  "session_revoked",
  "password_reset_requested",
  "password_reset_used",
  "admin_action",
  "document_deleted",
  "account_deleted",
  "export_completed",
  "authorization_denied",
  "server_error",
] as const;

export type SecurityEventType = (typeof SECURITY_EVENTS)[number];

export const ADMIN_ACTIONS = [
  "admin.create_user",
  "admin.reset_password",
  "admin.disable_mfa",
  "admin.revoke_sessions",
  "admin.rotate_kek",
  "admin.revoke_dek",
  "admin.dek_revoked",
  "admin.check_roles",
  "admin.replay_erasures",
] as const;

export type AdminAction = (typeof ADMIN_ACTIONS)[number];

const ADMIN_ACTION_SET = new Set<string>(ADMIN_ACTIONS);

export function adminAction(value: string | undefined): AdminAction | undefined {
  if (value !== undefined && ADMIN_ACTION_SET.has(value)) {
    return value as AdminAction;
  }
  return undefined;
}

export type SecurityEvent = {
  type: SecurityEventType;
  userId?: string | null;
  sessionId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  result: "succes" | "echec";
  action?: string;
};

const SENSITIVE_KEY =
  /authorization|cookie|password|passwd|token|secret|totp|title|content|body|reset|set-cookie/i;

export function hashSession(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
}

export function summarizeUserAgent(value: string | null | undefined): string {
  if (value === null || value === undefined || value.length === 0) {
    return "inconnu";
  }
  const token = value.split(/[^A-Za-z0-9./]+/).find((part) => part.length > 0) ?? "";
  if (token.length === 0 || token.length > 40) {
    return "inconnu";
  }
  return token;
}

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry));
  }
  if (value !== null && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key)) {
        continue;
      }
      output[key] = redact(entry);
    }
    return output;
  }
  return value;
}

export function securityRecord(event: SecurityEvent, now: Date = new Date()): Record<string, unknown> {
  const action = adminAction(event.action);
  return redact({
    ts: now.toISOString(),
    type: event.type,
    user_id: event.userId ?? null,
    session_id: event.sessionId == null || event.sessionId.length === 0 ? null : hashSession(event.sessionId),
    ip: event.ip ?? null,
    user_agent: summarizeUserAgent(event.userAgent),
    result: event.result,
    ...(action === undefined ? {} : { action }),
  }) as Record<string, unknown>;
}

export function writeSecurityLog(stream: Writable, event: SecurityEvent, now?: Date): void {
  stream.write(`${JSON.stringify(securityRecord(event, now))}\n`);
}
