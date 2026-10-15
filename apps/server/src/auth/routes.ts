/**
 * Routes /api/auth/*, /api/v1/me et garde d'authentification.
 * Les mutations par cookie exigent Origin (ou Sec-Fetch-Site: same-origin) et JSON.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { AppConfig } from "../config/load.ts";
import type { LoadedSecrets } from "../config/secrets.ts";
import { resolvedClientIp } from "../platform/healthz.ts";
import { sendProblem } from "../platform/problem.ts";
import { writeSecurityLog, type SecurityEvent } from "../platform/security-log.ts";
import type { Writable } from "node:stream";
import type { Pool } from "pg";

import { clearSessionCookie, readBearer, readCookie, serializeSessionCookie, SESSION_COOKIE } from "./cookie.ts";
import { LOGIN_HTML, AUTH_REQUIRED, BAD_REQUEST, FORGOT_MESSAGE, INVALID_LOGIN, ORIGIN_REJECTED, PASSWORD_REJECTED, TOO_MANY } from "./html.ts";
import { ARGON_TARGET, type ArgonParams } from "./password.ts";
import { openAuth } from "./service.ts";

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
  { method: "GET", url: "/api/v1/me", auth: true },
  { method: "GET", url: "/api/v1/documents", auth: true },
  { method: "DELETE", url: "/api/v1/documents/:id", auth: true },
] as const;

export const AUTH_ROUTES = [...PUBLIC_ROUTES, ...PROTECTED_ROUTES] as const;

const PUBLIC_MUTATING = new Set(["POST /api/auth/sign-in", "POST /api/auth/sign-up", "POST /api/auth/forget-password"]);

const signInSchema = z
  .object({
    identifier: z.string().min(1).max(320),
    password: z.string().min(1).max(1024),
    remember: z.boolean().optional(),
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
};

const sessions = new WeakMap<FastifyRequest, SessionContext>();

export function sessionOf(request: FastifyRequest): SessionContext | undefined {
  return sessions.get(request);
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
  for (const candidate of [config.PUBLIC_URL, config.BETTER_AUTH_URL]) {
    if (candidate === undefined) {
      continue;
    }
    values.add(new URL(candidate).origin);
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
  if (!json && !bareDelete && !formSignIn) {
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
  return reply.code(status).type("application/json; charset=utf-8").send({ message });
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
        })
      : null;

  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => {
      done(null, body);
    },
  );

  readiness.set(app, auth?.ready() ?? Promise.resolve());
  const extraPublic = runtime.extraPublicRoutes ?? [];

  app.addHook("preHandler", async (request, reply) => {
    const pattern = request.routeOptions.url;
    const key = `${request.method} ${pattern ?? ""}`;
    const mutating = request.method === "POST" || request.method === "PUT" || request.method === "PATCH" || request.method === "DELETE";
    const cookie = readCookie(headerValue(request.headers.cookie), SESSION_COOKIE);
    const bearer = readBearer(headerValue(request.headers.authorization));
    const isPublic = pattern !== undefined && isPublicRoute(request.method, pattern, extraPublic);
    if (mutating && (cookie !== undefined || PUBLIC_MUTATING.has(key))) {
      if (!csrfOk(request, config)) {
        return sendMessage(reply, 403, ORIGIN_REJECTED);
      }
    }
    if (isPublic) {
      return undefined;
    }
    if (cookie === undefined && bearer === undefined) {
      return sendMessage(reply, 401, AUTH_REQUIRED);
    }
    if (auth === null) {
      return sendProblem(reply, 500);
    }
    const token = cookie ?? bearer;
    const session = await auth.resolve(token);
    if (session === null) {
      return sendMessage(reply, 401, AUTH_REQUIRED);
    }
    sessions.set(request, { userId: session.owner_id, sessionId: session.id, token: token ?? "" });
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
    });
    if (result.kind === "limited") {
      return sendMessage(reply, 429, TOO_MANY, result.retryAfter);
    }
    if (result.kind === "invalid") {
      return sendMessage(reply, 401, INVALID_LOGIN);
    }
    reply.header("set-cookie", serializeSessionCookie(result.token, result.maxAge));
    return { id: result.userId, identifier: result.identifier };
  });

  app.post("/api/auth/sign-out", async (request, reply) => {
    const current = sessionOf(request);
    if (auth === null || current === undefined) {
      return sendMessage(reply, 401, AUTH_REQUIRED);
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
      return sendMessage(reply, 401, AUTH_REQUIRED);
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
      return sendMessage(reply, 401, INVALID_LOGIN);
    }
    reply.header("set-cookie", serializeSessionCookie(result.token, result.maxAge));
    return { ok: true as const };
  });

  app.get("/api/auth/sessions", async (request, reply) => {
    const current = sessionOf(request);
    if (auth === null || current === undefined) {
      return sendMessage(reply, 401, AUTH_REQUIRED);
    }
    return { devices: await auth.devices(current.userId, current.sessionId) };
  });

  app.get("/api/v1/me", async (request, reply) => {
    const current = sessionOf(request);
    if (auth === null || current === undefined) {
      return sendMessage(reply, 401, AUTH_REQUIRED);
    }
    const profile = await auth.profile(current.userId);
    if (profile === null || (profile.role !== "user" && profile.role !== "admin")) {
      return sendMessage(reply, 401, AUTH_REQUIRED);
    }
    return profile;
  });

  app.get("/api/v1/documents", async (request, reply) => {
    const current = sessionOf(request);
    if (auth === null || current === undefined) {
      return sendMessage(reply, 401, AUTH_REQUIRED);
    }
    const documents = await auth.listDocuments(current.userId);
    return { documents: documents.map((id) => ({ id })) };
  });

  app.delete("/api/v1/documents/:id", async (request, reply) => {
    const current = sessionOf(request);
    if (auth === null || current === undefined) {
      return sendMessage(reply, 401, AUTH_REQUIRED);
    }
    const params = z.object({ id: z.uuid() }).safeParse(request.params);
    if (!params.success) {
      return sendProblem(reply, 404);
    }
    const removed = await auth.deleteDocument(current.userId, params.data.id);
    if (!removed) {
      return sendProblem(reply, 404);
    }
    return reply.code(204).send();
  });
}
