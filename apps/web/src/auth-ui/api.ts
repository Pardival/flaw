/**
 * Client partagé des écrans d'authentification (SEC-WEB-05).
 * Toute mutation par cookie part avec Content-Type JSON et l'en-tête x-flaw-csrf.
 * Le navigateur ajoute Origin et le cookie HttpOnly. Ce module ne stocke aucun jeton.
 */
import { IDENTIFIER_MAX_LENGTH, passwordAccepted } from "./policy.ts";

export const CSRF_HEADER = "x-flaw-csrf";
export const CSRF_VALUE = "same-origin";

/** Détail 401 de POST /api/auth/sign-in lorsque le second facteur est exigé. */
const MFA_CHALLENGE_DETAIL = "code d'authentification requis";
const PASSWORD_REJECTED_DETAIL = "mot de passe refusé";
const MFA_REQUIRED_CODE = "mfa_required";

export const AUTH_PATHS = {
  signIn: "/api/auth/sign-in",
  signOut: "/api/auth/sign-out",
  forgetPassword: "/api/auth/forget-password",
  changePassword: "/api/auth/change-password",
  me: "/api/v1/me",
} as const;

export type MeProfile = {
  id: string;
  email: string;
  role: "user" | "admin";
  locale: string;
  timeZone: string;
  mfaEnrolled: boolean;
  passwordMustChange: boolean;
};

export type FailureKind =
  | "unauthorized"
  | "mfa_required"
  | "forbidden"
  | "invalid"
  | "limited"
  | "rejected"
  | "network"
  | "server";

export type AuthSuccess<T> = { ok: true; status: number; data: T };
export type AuthFailure = {
  ok: false;
  status: number;
  kind: FailureKind;
  retryAfter: number | null;
};
export type AuthResult<T> = AuthSuccess<T> | AuthFailure;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type AuthClientOptions = {
  fetch?: FetchLike;
  /** Réservé aux appelants hors navigateur. Le navigateur refuse de fixer Origin. */
  origin?: string;
};

export type AuthFetchInit = {
  method?: string;
  body?: unknown;
  headers?: HeadersInit;
  signal?: AbortSignal;
};

export type Credentials = {
  identifier: string;
  password: string;
  remember: boolean;
};

export type PasswordChange = {
  currentPassword: string;
  newPassword: string;
};

export type AuthClient = {
  fetch: (path: string, init?: AuthFetchInit) => Promise<Response>;
  signIn: (value: Credentials) => Promise<AuthResult<{ id: string; identifier: string }>>;
  signOut: () => Promise<AuthResult<{ ok: true }>>;
  forgetPassword: (identifier: string) => Promise<AuthResult<{ message: string }>>;
  changePassword: (value: PasswordChange) => Promise<AuthResult<{ ok: true }>>;
  me: () => Promise<AuthResult<MeProfile>>;
};

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isMutating(method: string): boolean {
  return MUTATING.has(method.toUpperCase());
}

export function normalizeIdentifier(raw: string): string | null {
  const value = raw.normalize("NFC").trim().toLowerCase();
  if (value.length === 0 || value.length > IDENTIFIER_MAX_LENGTH) {
    return null;
  }
  return value;
}

export function csrfHeaders(method: string): Headers {
  const headers = new Headers();
  if (isMutating(method)) {
    headers.set("content-type", "application/json");
    headers.set(CSRF_HEADER, CSRF_VALUE);
  }
  return headers;
}

function defaultFetch(input: string, init?: RequestInit): Promise<Response> {
  return fetch(input, init);
}

export function authFetch(path: string, init: AuthFetchInit = {}, options: AuthClientOptions = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = csrfHeaders(method);
  if (init.headers !== undefined) {
    new Headers(init.headers).forEach((value, key) => {
      const name = key.toLowerCase();
      if (name === "content-type" || name === CSRF_HEADER) {
        return;
      }
      headers.set(key, value);
    });
  }
  headers.set("accept", "application/json");
  if (isMutating(method)) {
    headers.set("content-type", "application/json");
    headers.set(CSRF_HEADER, CSRF_VALUE);
    if (options.origin !== undefined) {
      headers.set("origin", options.origin);
    }
  }
  const fetchImpl = options.fetch ?? defaultFetch;
  return fetchImpl(path, {
    method,
    headers,
    credentials: "include",
    cache: "no-store",
    mode: "same-origin",
    signal: init.signal,
    body: isMutating(method) ? JSON.stringify(init.body ?? {}) : undefined,
  });
}

function failure(kind: FailureKind, status = 0): AuthFailure {
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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function problemDetail(value: unknown): { code: string | null; detail: string | null } {
  const record = asRecord(value);
  if (record === null) {
    return { code: null, detail: null };
  }
  return {
    code: typeof record.code === "string" ? record.code : null,
    detail: typeof record.detail === "string" ? record.detail : null,
  };
}

export function failureKind(status: number, payload: unknown): FailureKind {
  const problem = problemDetail(payload);
  if (problem.code === MFA_REQUIRED_CODE || problem.detail === MFA_CHALLENGE_DETAIL) {
    return "mfa_required";
  }
  if (status === 401) {
    return "unauthorized";
  }
  if (status === 403) {
    return "forbidden";
  }
  if (status === 429) {
    return "limited";
  }
  if (status === 400 && problem.detail === PASSWORD_REJECTED_DETAIL) {
    return "rejected";
  }
  if (status === 400) {
    return "invalid";
  }
  return "server";
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

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isProfile(value: unknown): value is MeProfile {
  const record = asRecord(value);
  if (record === null) {
    return false;
  }
  return (
    nonEmpty(record.id) &&
    nonEmpty(record.email) &&
    (record.role === "user" || record.role === "admin") &&
    nonEmpty(record.locale) &&
    nonEmpty(record.timeZone) &&
    typeof record.mfaEnrolled === "boolean" &&
    typeof record.passwordMustChange === "boolean"
  );
}

function profileFrom(value: unknown): MeProfile | null {
  if (!isProfile(value)) {
    return null;
  }
  return {
    id: value.id,
    email: value.email,
    role: value.role,
    locale: value.locale,
    timeZone: value.timeZone,
    mfaEnrolled: value.mfaEnrolled,
    passwordMustChange: value.passwordMustChange,
  };
}

export function createAuthClient(options: AuthClientOptions = {}): AuthClient {
  async function call(method: string, path: string, body?: unknown): Promise<AuthResult<unknown>> {
    try {
      const response = await authFetch(path, { method, body }, options);
      return await exchange(response);
    } catch {
      return failure("network");
    }
  }

  return {
    fetch: (path, init) => authFetch(path, init, options),
    async signIn(value) {
      const identifier = normalizeIdentifier(value.identifier);
      if (identifier === null || value.password.length === 0) {
        return failure("invalid", 400);
      }
      const body: { identifier: string; password: string; remember?: boolean } = {
        identifier,
        password: value.password.normalize("NFC"),
      };
      if (value.remember) {
        body.remember = true;
      }
      const result = await call("POST", AUTH_PATHS.signIn, body);
      if (!result.ok) {
        return result;
      }
      const record = asRecord(result.data);
      if (record === null || !nonEmpty(record.id) || !nonEmpty(record.identifier)) {
        return failure("server", result.status);
      }
      return { ok: true, status: result.status, data: { id: record.id, identifier: record.identifier } };
    },
    async signOut() {
      const result = await call("POST", AUTH_PATHS.signOut, {});
      if (!result.ok) {
        return result;
      }
      const record = asRecord(result.data);
      if (record?.ok !== true) {
        return failure("server", result.status);
      }
      return { ok: true, status: result.status, data: { ok: true } };
    },
    async forgetPassword(identifier) {
      const normalized = normalizeIdentifier(identifier);
      if (normalized === null) {
        return failure("invalid", 400);
      }
      const result = await call("POST", AUTH_PATHS.forgetPassword, { identifier: normalized });
      if (!result.ok) {
        return result;
      }
      const record = asRecord(result.data);
      if (record === null || typeof record.message !== "string") {
        return failure("server", result.status);
      }
      return { ok: true, status: result.status, data: { message: record.message } };
    },
    async changePassword(value) {
      if (value.currentPassword.length === 0) {
        return failure("invalid", 400);
      }
      if (!passwordAccepted(value.newPassword)) {
        return failure("rejected", 400);
      }
      const result = await call("POST", AUTH_PATHS.changePassword, {
        currentPassword: value.currentPassword.normalize("NFC"),
        newPassword: value.newPassword.normalize("NFC"),
      });
      if (!result.ok) {
        return result;
      }
      const record = asRecord(result.data);
      if (record?.ok !== true) {
        return failure("server", result.status);
      }
      return { ok: true, status: result.status, data: { ok: true } };
    },
    async me() {
      const result = await call("GET", AUTH_PATHS.me);
      if (!result.ok) {
        return result;
      }
      const profile = profileFrom(result.data);
      if (profile === null) {
        return failure("server", result.status);
      }
      return { ok: true, status: result.status, data: profile };
    },
  };
}
