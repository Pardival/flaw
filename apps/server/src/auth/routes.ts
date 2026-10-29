/**
 * Routes /api/auth/*, /api/v1/me et garde d'authentification.
 * Les mutations par cookie exigent Origin (ou Sec-Fetch-Site: same-origin).
 * Le corps est du JSON, sauf le repli de synchro (application/octet-stream).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { parseRecoveryPepperOldIds } from "../config/env.ts";
import type { AppConfig } from "../config/load.ts";
import type { LoadedSecrets } from "../config/secrets.ts";
import { resolvedClientIp } from "../platform/healthz.ts";
import { sendMfaRequired, sendProblem, sendReauthRequired } from "../platform/problem.ts";
import { writeSecurityLog, type SecurityEvent } from "../platform/security-log.ts";
import type { Writable } from "node:stream";
import type { Pool } from "pg";

import { registerContentRoutes } from "../documents/routes.ts";
import type { AccessActor } from "../access/can.ts";
import { clearSessionCookie, DEVICE_COOKIE, readBearer, readCookie, serializeDeviceCookie, serializeSessionCookie, SESSION_COOKIE } from "./cookie.ts";
import { LOGIN_HTML, BAD_REQUEST, ENROLL_REFUSED, FORGOT_MESSAGE, MFA_REQUIRED, ORIGIN_REJECTED, PASSWORD_REJECTED, RESTRICTED, TOO_MANY } from "./html.ts";
import { ARGON_TARGET, type ArgonParams } from "./password.ts";
import { restrictedAllows } from "./restricted-session.ts";
import { openAuth } from "./service.ts";
import { decodeValidatedKey } from "../crypto/kek.ts";
import { attachSync } from "../sync/hocuspocus.ts";
import { registerPreferences } from "../preferences/routes.ts";
import { registerStats } from "../stats/routes.ts";
import { registerVersions } from "../versions/routes.ts";
import { registerExports } from "../exports/routes.ts";
import { registerAccountExport } from "../account/export.ts";

export const PUBLIC_ROUTES = [
  { method: "GET", url: "/login", auth: false },
  { method: "GET", url: "/api/v1/healthz", auth: false },
  { method: "POST", url: "/api/auth/sign-in", auth: false },
  { method: "POST", url: "/api/auth/sign-up", auth: false },
  { method: "POST", url: "/api/auth/forget-password", auth: false },
] as const;

export const PROTECTED_ROUTES = [
  { method: "POST", url: "/api/auth/sign-out", auth: true },
  { method: "POST", url: "/api/auth/change-password", auth: true },
  { method: "GET", url: "/api/auth/sessions", auth: true },
  { method: "GET", url: "/api/v1/me/sessions", auth: true },
  { method: "DELETE", url: "/api/v1/me/sessions", auth: true },
  { method: "DELETE", url: "/api/v1/me/sessions/:sessionId", auth: true },
  { method: "GET", url: "/api/v1/me", auth: true },
  { method: "GET", url: "/api/v1/me/preferences", auth: true },
  { method: "PATCH", url: "/api/v1/me/preferences", auth: true },
  { method: "GET", url: "/api/v1/stats/daily", auth: true },
  { method: "GET", url: "/api/v1/documents/:documentId/versions", auth: true },
  { method: "POST", url: "/api/v1/documents/:documentId/exports", auth: true },
  { method: "POST", url: "/api/v1/me/export", auth: true },
  { method: "POST", url: "/api/v1/documents/:documentId/versions", auth: true },
  { method: "POST", url: "/api/v1/documents/:documentId/versions/:versionId/restore", auth: true },
  { method: "GET", url: "/api/v1/documents/:documentId/versions/:versionId/preview", auth: true },
  { method: "PUT", url: "/api/v1/stats/daily/:day/devices/:deviceId", auth: true },
  { method: "GET", url: "/api/v1/documents", auth: true },
  { method: "POST", url: "/api/v1/documents", auth: true },
  { method: "GET", url: "/api/v1/documents/:documentId", auth: true },
  { method: "PATCH", url: "/api/v1/documents/:documentId", auth: true },
  { method: "DELETE", url: "/api/v1/documents/:documentId", auth: true },
  { method: "POST", url: "/api/v1/documents/:documentId/restore", auth: true },
  { method: "GET", url: "/api/v1/documents/:documentId/content", auth: true },
  { method: "POST", url: "/api/v1/documents/:documentId/sync", auth: true },
  { method: "POST", url: "/api/auth/mfa/enroll", auth: true },
  { method: "POST", url: "/api/auth/mfa/verify", auth: true },
] as const;

export const AUTH_ROUTES = [...PUBLIC_ROUTES, ...PROTECTED_ROUTES] as const;

const PUBLIC_MUTATING = new Set(["POST /api/auth/sign-in", "POST /api/auth/sign-up", "POST /api/auth/forget-password"]);

const signInSchema = z
  .object({
    identifier: z.string().min(1).max(320),
    password: z.string().min(1).max(1024),
    remember: z.boolean().optional(),
    totp: z.string().regex(/^\d{6}$/).optional(),
    recoveryCode: z.string().min(1).max(64).optional(),
  })
  .strict();

const identifierSchema = z
  .object({
    identifier: z.string().min(1).max(320),
  })
  .strict();

const changeSchema = z
  .object({
    currentPassword: z.string().min(1).max(1024),
    newPassword: z.string().min(1).max(1024),
  })
  .strict();

export type AuthRuntime = {
  pool?: Pool;
  secrets?: LoadedSecrets;
  now?: () => Date;
  argon?: ArgonParams;
  logStream?: Writable;
  extraPublicRoutes?: readonly string[];
};

const readiness = new WeakMap<FastifyInstance, Promise<void>>();

export function whenAuthReady(app: FastifyInstance): Promise<void> {
  return readiness.get(app) ?? Promise.resolve();
}

export function isPublicRoute(method: string, url: string, extra: readonly string[] = []): boolean {
  const key = `${method} ${url}`;
  if (PUBLIC_ROUTES.some((route) => `${route.method} ${route.url}` === key) || extra.includes(key)) {
    return true;
  }
  if (method === "HEAD") {
    return isPublicRoute("GET", url, extra);
  }
  return false;
}

type SessionContext = {
  userId: string;
  sessionId: string;
  token: string;
  restricted: boolean;
};

type TokenGate = {
  resolve: (token: string) => Promise<boolean>;
};

const gates = new WeakMap<FastifyInstance, TokenGate>();
const bearerFlags = new WeakMap<FastifyInstance, boolean>();

export type AnonymousDecision = { kind: "anonymous" } | { kind: "present" };

export function queryTokenPresent(request: FastifyRequest): boolean {
  const query = request.query;
  if (query === null || typeof query !== "object") {
    return false;
  }
  return Object.keys(query).some((key) => key.toLowerCase() === "token");
}

const sessions = new WeakMap<FastifyRequest, SessionContext>();

export function sessionOf(request: FastifyRequest): SessionContext | undefined {
  return sessions.get(request);
}

export async function anonymousRequest(app: FastifyInstance, request: FastifyRequest): Promise<AnonymousDecision> {
  if (queryTokenPresent(request)) {
    return { kind: "anonymous" };
  }
  const cookie = readCookie(headerValue(request.headers.cookie), SESSION_COOKIE);
  const bearer = bearerFlags.get(app) === true ? readBearer(headerValue(request.headers.authorization)) : undefined;
  if (cookie !== undefined && bearer !== undefined && cookie !== bearer) {
    return { kind: "anonymous" };
  }
  const token = cookie ?? bearer;
  const gate = gates.get(app);
  if (token === undefined || gate === undefined || !(await gate.resolve(token))) {
    return { kind: "anonymous" };
  }
  return { kind: "present" };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function clientIp(request: FastifyRequest, cidr: string): string {
  return resolvedClientIp(
    request.socket.remoteAddress ?? "",
    headerValue(request.headers["x-real-ip"]),
    cidr,
  );
}

export function allowedOrigins(config: AppConfig): Set<string> {
  const values = new Set<string>();
  if (config.PUBLIC_URL !== undefined) {
    values.add(new URL(config.PUBLIC_URL).origin);
  }
  for (const part of config.TRUSTED_ORIGINS.split(",")) {
    const trimmed = part.trim();
    if (trimmed !== "") {
      values.add(trimmed);
    }
  }
  return values;
}

function csrfOk(request: FastifyRequest, config: AppConfig): boolean {
  const contentType = (headerValue(request.headers["content-type"]) ?? "").toLowerCase();
  const json = contentType.startsWith("application/json");
  const bareDelete = request.method === "DELETE" && contentType.length === 0;
  const formSignIn =
    request.method === "POST" &&
    request.routeOptions.url === "/api/auth/sign-in" &&
    contentType.startsWith("application/x-www-form-urlencoded");
  const syncBytes =
    request.method === "POST" &&
    request.routeOptions.url === "/api/v1/documents/:documentId/sync" &&
    contentType.startsWith("application/octet-stream");
  if (!json && !bareDelete && !formSignIn && !syncBytes) {
    return false;
  }
  const allowed = allowedOrigins(config);
  const origin = headerValue(request.headers.origin);
  if (origin !== undefined) {
    return allowed.has(origin);
  }
  return headerValue(request.headers["sec-fetch-site"]) === "same-origin" && allowed.size > 0;
}

function sendMessage(
  reply: FastifyReply,
  status: 400 | 401 | 403 | 429,
  message: string,
  retryAfter?: number,
): unknown {
  if (retryAfter !== undefined) {
    reply.header("retry-after", String(retryAfter));
  }
  return sendProblem(reply, status, message);
}

function sendUnauthorized(reply: FastifyReply): unknown {
  return sendProblem(reply, 401);
}

function credentialsFrom(body: unknown): unknown {
  if (typeof body !== "string") {
    return body;
  }
  const params = new URLSearchParams(body);
  const remember = params.get("remember");
  return {
    identifier: params.get("identifier") ?? "",
    password: params.get("password") ?? "",
    ...(remember === "true" || remember === "false" ? { remember: remember === "true" } : {}),
  };
}

function recoveryPepperMap(secrets: LoadedSecrets, config: AppConfig): Map<string, Uint8Array> {
  const peppers = new Map<string, Uint8Array>();
  const current = decodeValidatedKey(secrets.recoveryPepper);
  if (current !== null) {
    peppers.set(config.RECOVERY_PEPPER_ID, current);
  }
  const parsed = parseRecoveryPepperOldIds(config.RECOVERY_PEPPER_ID, config.RECOVERY_PEPPER_OLD_IDS);
  if (!parsed.ok) {
    return peppers;
  }
  for (const id of parsed.ids) {
    const encoded = secrets.recoveryPepperOld?.[id];
    if (encoded === undefined) {
      continue;
    }
    const decoded = decodeValidatedKey(encoded);
    if (decoded !== null) {
      peppers.set(id, decoded);
    }
  }
  return peppers;
}

function normalizeIdentifier(raw: string): string | null {
  const value = raw.normalize("NFC").trim().toLowerCase();
  if (value.length === 0 || value.length > 320) {
    return null;
  }
  return value;
}

export function registerAuth(app: FastifyInstance, config: AppConfig, runtime: AuthRuntime = {}): void {
  const stream = runtime.logStream ?? process.stdout;
  const auth =
    runtime.pool !== undefined && runtime.secrets !== undefined
      ? openAuth({
          pool: runtime.pool,
          pepper: runtime.secrets.hmacPepper,
          pepperId: config.HMAC_PEPPER_ID,
          minLength: config.PASSWORD_MIN_LENGTH,
          idleDays: config.SESSION_IDLE_DAYS,
          maxDays: config.SESSION_MAX_DAYS,
          argon: runtime.argon ?? ARGON_TARGET,
          now: runtime.now ?? (() => new Date()),
          onEvent: (event: SecurityEvent) => {
            writeSecurityLog(stream, event);
          },
          kek: decodeValidatedKey(runtime.secrets.kek) ?? undefined,
          kekId: config.FLAW_KEK_ID,
          recoveryPepper: decodeValidatedKey(runtime.secrets.recoveryPepper) ?? undefined,
          recoveryPepperId: config.RECOVERY_PEPPER_ID,
          recoveryPeppers: recoveryPepperMap(runtime.secrets, config),
        })
      : null;

  gates.set(app, {
    resolve: async (token) => {
      if (auth === null) {
        return false;
      }
      return (await auth.resolve(token)) !== null;
    },
  });

  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => {
      done(null, body);
    },
  );

  readiness.set(app, auth?.ready() ?? Promise.resolve());
  bearerFlags.set(app, config.bearerEnabled);
  const extraPublic = runtime.extraPublicRoutes ?? [];

  app.addHook("preHandler", async (request, reply) => {
    if (queryTokenPresent(request)) {
      return sendUnauthorized(reply);
    }
    const pattern = request.routeOptions.url;
    const key = `${request.method} ${pattern ?? ""}`;
    const mutating = request.method === "POST" || request.method === "PUT" || request.method === "PATCH" || request.method === "DELETE";
    const cookie = readCookie(headerValue(request.headers.cookie), SESSION_COOKIE);
    const bearer = config.bearerEnabled ? readBearer(headerValue(request.headers.authorization)) : undefined;
    const isPublic = pattern !== undefined && isPublicRoute(request.method, pattern, extraPublic);
    if (mutating && (cookie !== undefined || PUBLIC_MUTATING.has(key))) {
      if (!csrfOk(request, config)) {
        return sendMessage(reply, 403, ORIGIN_REJECTED);
      }
    }
    if (isPublic) {
      return undefined;
    }
    if (cookie !== undefined && bearer !== undefined && cookie !== bearer) {
      writeSecurityLog(stream, {
        type: "authorization_denied",
        result: "echec",
        userId: null,
        ip: clientIp(request, config.TRUSTED_PROXY_CIDR),
        userAgent: headerValue(request.headers["user-agent"]) ?? null,
      });
      return sendUnauthorized(reply);
    }
    if (cookie === undefined && bearer === undefined) {
      return sendUnauthorized(reply);
    }
    if (auth === null) {
      return sendProblem(reply, 500);
    }
    const ip = clientIp(request, config.TRUSTED_PROXY_CIDR);
    const ahead = await auth.invalidTokenLimited(ip);
    if (ahead !== null) {
      return sendMessage(reply, 429, TOO_MANY, ahead.retryAfter);
    }
    const token = cookie ?? bearer;
    const session = await auth.resolve(token);
    if (session === null) {
      if (token !== undefined && request.method === "POST" && pattern === "/api/auth/mfa/verify") {
        const blocked = await auth.mfaVerifyBlocked(token);
        if (blocked !== null) {
          return sendMessage(reply, 429, TOO_MANY, blocked.retryAfter);
        }
      }
      const noted = await auth.noteInvalidToken(ip);
      if (noted !== null) {
        return sendMessage(reply, 429, TOO_MANY, noted.retryAfter);
      }
      return sendUnauthorized(reply);
    }
    if (session.restricted && !restrictedAllows(request.method, pattern ?? "")) {
      const mfaContract =
        (request.method === "GET" && pattern === "/api/v1/me") ||
        pattern === "/api/v1/me/sessions" ||
        pattern === "/api/v1/me/sessions/:sessionId";
      if (mfaContract) {
        return sendMfaRequired(reply);
      }
      return sendMessage(reply, 403, RESTRICTED);
    }
    sessions.set(request, {
      userId: session.owner_id,
      sessionId: session.id,
      token: token ?? "",
      restricted: session.restricted,
    });
    return undefined;
  });

  app.get("/login", async (_request, reply) => {
    return reply.type("text/html; charset=utf-8").send(LOGIN_HTML);
  });

  app.post("/api/auth/sign-up", async (_request, reply) => {
    return sendProblem(reply, 404);
  });

  app.post("/api/auth/forget-password", async (request, reply) => {
    if (auth === null) {
      return sendProblem(reply, 500);
    }
    const limited = await auth.forgetPassword(clientIp(request, config.TRUSTED_PROXY_CIDR));
    if (limited.kind === "limited") {
      return sendMessage(reply, 429, TOO_MANY, limited.retryAfter);
    }
    const parsed = identifierSchema.safeParse(request.body);
    if (!parsed.success || normalizeIdentifier(parsed.data.identifier) === null) {
      return sendMessage(reply, 400, BAD_REQUEST);
    }
    writeSecurityLog(stream, {
      type: "password_reset_requested",
      result: "succes",
      ip: clientIp(request, config.TRUSTED_PROXY_CIDR),
      userAgent: headerValue(request.headers["user-agent"]) ?? null,
    });
    return { message: FORGOT_MESSAGE };
  });

  app.post("/api/auth/sign-in", async (request, reply) => {
    if (auth === null) {
      return sendProblem(reply, 500);
    }
    const parsed = signInSchema.safeParse(credentialsFrom(request.body));
    if (!parsed.success) {
      return sendMessage(reply, 400, BAD_REQUEST);
    }
    const identifier = normalizeIdentifier(parsed.data.identifier);
    if (identifier === null) {
      return sendMessage(reply, 400, BAD_REQUEST);
    }
    const result = await auth.signIn({
      identifier,
      password: parsed.data.password,
      remember: parsed.data.remember === true,
      ip: clientIp(request, config.TRUSTED_PROXY_CIDR),
      userAgent: headerValue(request.headers["user-agent"]),
      ...(parsed.data.totp === undefined ? {} : { totp: parsed.data.totp }),
      ...(parsed.data.recoveryCode === undefined ? {} : { recoveryCode: parsed.data.recoveryCode }),
      deviceToken: readCookie(headerValue(request.headers.cookie), DEVICE_COOKIE),
    });
    if (result.kind === "limited") {
      return sendMessage(reply, 429, TOO_MANY, result.retryAfter);
    }
    if (result.kind === "mfa") {
      return sendMessage(reply, 401, MFA_REQUIRED);
    }
    if (result.kind === "invalid") {
      return sendUnauthorized(reply);
    }
    const cookies = [serializeSessionCookie(result.token, result.maxAge)];
    if (result.deviceToken !== undefined) {
      cookies.push(serializeDeviceCookie(result.deviceToken));
    }
    reply.header("set-cookie", cookies.length === 1 ? cookies[0]! : cookies);
    return { id: result.userId, identifier: result.identifier };
  });

  app.post("/api/auth/sign-out", async (request, reply) => {
    const current = sessionOf(request);
    if (auth === null || current === undefined) {
      return sendUnauthorized(reply);
    }
    await auth.signOut(
      current.sessionId,
      current.userId,
      clientIp(request, config.TRUSTED_PROXY_CIDR),
      headerValue(request.headers["user-agent"]),
    );
    reply.header("set-cookie", clearSessionCookie());
    return { ok: true as const };
  });

  app.post("/api/auth/change-password", async (request, reply) => {
    const current = sessionOf(request);
    if (auth === null || current === undefined) {
      return sendUnauthorized(reply);
    }
    const parsed = changeSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendMessage(reply, 400, BAD_REQUEST);
    }
    const result = await auth.changePassword(
      current.userId,
      current.sessionId,
      parsed.data.currentPassword,
      parsed.data.newPassword,
      clientIp(request, config.TRUSTED_PROXY_CIDR),
      headerValue(request.headers["user-agent"]),
    );
    if (result.kind === "limited") {
      return sendMessage(reply, 429, TOO_MANY, result.retryAfter);
    }
    if (result.kind === "rejected") {
      return sendMessage(reply, 400, PASSWORD_REJECTED);
    }
    if (result.kind === "invalid") {
      return sendUnauthorized(reply);
    }
    reply.header("set-cookie", serializeSessionCookie(result.token, result.maxAge));
    return { ok: true as const };
  });

  const mfaCode = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();

  app.post("/api/auth/mfa/enroll", async (request, reply) => {
    const current = sessionOf(request);
    if (auth === null || current === undefined) {
      return sendUnauthorized(reply);
    }
    const result = await auth.enroll(
      current.userId,
      current.restricted,
      clientIp(request, config.TRUSTED_PROXY_CIDR),
      headerValue(request.headers["user-agent"]),
    );
    if (result.kind === "forbidden") {
      return sendMessage(reply, 403, ENROLL_REFUSED);
    }
    return { secret: result.secret, codes: result.codes };
  });

  app.post("/api/auth/mfa/verify", async (request, reply) => {
    const current = sessionOf(request);
    if (auth === null || current === undefined) {
      return sendUnauthorized(reply);
    }
    const parsed = mfaCode.safeParse(request.body);
    if (!parsed.success) {
      return sendMessage(reply, 400, BAD_REQUEST);
    }
    const result = await auth.verifyMfa(
      current.userId,
      current.sessionId,
      parsed.data.code,
      headerValue(request.headers["user-agent"]),
      clientIp(request, config.TRUSTED_PROXY_CIDR),
    );
    if (result.kind === "forbidden") {
      return sendMessage(reply, 403, ENROLL_REFUSED);
    }
    if (result.kind === "limited") {
      return sendMessage(reply, 429, TOO_MANY, result.retryAfter);
    }
    if (result.kind === "invalid") {
      return sendUnauthorized(reply);
    }
    reply.header("set-cookie", [
      serializeSessionCookie(result.token, result.maxAge),
      serializeDeviceCookie(result.deviceToken),
    ]);
    return { ok: true as const };
  });

  app.get("/api/auth/sessions", async (request, reply) => {
    const current = sessionOf(request);
    if (auth === null || current === undefined) {
      return sendUnauthorized(reply);
    }
    // Alias historique de listSessions : même service.devices, enveloppe { devices }.
    return { devices: await auth.devices(current.userId, current.sessionId) };
  });

  app.get("/api/v1/me/sessions", async (request, reply) => {
    const current = sessionOf(request);
    if (auth === null || current === undefined) {
      return sendUnauthorized(reply);
    }
    return auth.devices(current.userId, current.sessionId);
  });

  app.delete("/api/v1/me/sessions", async (request, reply) => {
    const current = sessionOf(request);
    if (auth === null || current === undefined) {
      return sendUnauthorized(reply);
    }
    const result = await auth.revokeOtherDevices(
      current.userId,
      current.sessionId,
      clientIp(request, config.TRUSTED_PROXY_CIDR),
      headerValue(request.headers["user-agent"]),
    );
    if (result.kind === "reauth") {
      return sendReauthRequired(reply);
    }
    return reply.code(204).send();
  });

  app.delete("/api/v1/me/sessions/:sessionId", async (request, reply) => {
    const current = sessionOf(request);
    if (auth === null || current === undefined) {
      return sendUnauthorized(reply);
    }
    const params = z.object({ sessionId: z.uuid() }).safeParse(request.params);
    if (!params.success) {
      return sendProblem(reply, 404);
    }
    const removed = await auth.revokeOwnedDevice(
      current.userId,
      params.data.sessionId,
      clientIp(request, config.TRUSTED_PROXY_CIDR),
      headerValue(request.headers["user-agent"]),
    );
    if (!removed) {
      return sendProblem(reply, 404);
    }
    return reply.code(204).send();
  });

  app.get("/api/v1/me", async (request, reply) => {
    const current = sessionOf(request);
    if (auth === null || current === undefined) {
      return sendUnauthorized(reply);
    }
    const profile = await auth.profile(current.userId);
    if (profile === null || (profile.role !== "user" && profile.role !== "admin")) {
      return sendUnauthorized(reply);
    }
    return profile;
  });

  const contentDeps = {
    pool: () => runtime.pool,
    kek: () => (runtime.secrets === undefined ? undefined : (decodeValidatedKey(runtime.secrets.kek) ?? undefined)),
    actor: async (request: FastifyRequest): Promise<AccessActor | undefined> => {
      const current = sessionOf(request);
      if (current === undefined || runtime.pool === undefined) {
        return undefined;
      }
      const result = await runtime.pool.query<{ role: string }>(
        "SELECT role FROM flaw.users WHERE id = $1",
        [current.userId],
      );
      const role = result.rows[0]?.role;
      if (role !== "user" && role !== "admin") {
        return undefined;
      }
      return { userId: current.userId, role };
    },
  };
  registerContentRoutes(app, contentDeps);
  registerVersions(app, contentDeps);
  registerExports(app, contentDeps);
  registerAccountExport(app, { ...contentDeps, sessionId: (request) => sessionOf(request)?.sessionId });

  registerPreferences(app, {
    pool: () => runtime.pool,
    userId: (request) => sessionOf(request)?.userId,
  });

  registerStats(app, {
    pool: () => runtime.pool,
    userId: (request) => sessionOf(request)?.userId,
  });

  attachSync(app, {
    pool: () => runtime.pool,
    kek: () => (runtime.secrets === undefined ? undefined : (decodeValidatedKey(runtime.secrets.kek) ?? undefined)),
    origins: () => allowedOrigins(config),
    maxPayload: config.bodyLimit,
    resolve: async (token) => {
      if (auth === null || runtime.pool === undefined) {
        return null;
      }
      const session = await auth.resolve(token);
      if (session === null || session.restricted) {
        return null;
      }
      const result = await runtime.pool.query<{ role: string }>("SELECT role FROM flaw.users WHERE id = $1", [
        session.owner_id,
      ]);
      const role = result.rows[0]?.role;
      return role === "user" || role === "admin" ? { userId: session.owner_id, role } : null;
    },
  });
}
