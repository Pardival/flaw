/**
 * Squelette Fastify (T-004) : configuration, erreurs RFC 9457, santé, journal.
 * Les secrets passent par loadSecrets → readSecretFile (validateur T-002).
 * L'image Docker lance ce fichier : node apps/server/src/app.ts.
 */
import { Buffer } from "node:buffer";
import { type Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import Fastify, { LogController, type FastifyInstance, type FastifyRequest } from "fastify";
import { Client, Pool } from "pg";
import { z } from "zod";

import { anonymousRequest, registerAuth, whenAuthReady, type AuthRuntime } from "./auth/routes.ts";
import { assertPasswordMinLength } from "./auth/password.ts";
import { holdSecrets, loadConfig, type AppConfig } from "./config/load.ts";
import type { LoadedSecrets } from "./config/secrets.ts";
import { assertAppRole } from "./db/migrate.ts";
import { resolvedClientIp } from "./platform/healthz.ts";
import { sendProblem, type ProblemStatus } from "./platform/problem.ts";
import { writeSecurityLog } from "./platform/security-log.ts";
import { firstAdminId } from "./auth/lookups.ts";
import { consignerResultatPurge } from "./crypto/purge.ts";
import { documentTitleSchema, SERVER_ASSIGNED_KEYS } from "./platform/validation.ts";

const healthQuerySchema = z.object({}).strict();

export type BuildOptions = AuthRuntime;

const declared = new WeakMap<FastifyInstance, Array<{ method: string; url: string }>>();

function trackRoutes(app: FastifyInstance): void {
  const list: Array<{ method: string; url: string }> = [];
  declared.set(app, list);
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      list.push({ method, url: route.url });
    }
  });
}

export function declaredRoutes(app: FastifyInstance): ReadonlyArray<{ method: string; url: string }> {
  return declared.get(app) ?? [];
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function clientIp(request: FastifyRequest, cidr: string): string {
  return resolvedClientIp(
    request.socket.remoteAddress ?? "",
    headerValue(request.headers["x-real-ip"]),
    cidr,
  );
}

function publicStatus(status: number): ProblemStatus {
  if (status === 400 || status === 404 || status === 413 || status === 500) {
    return status;
  }
  if (status >= 500) {
    return 500;
  }
  return 400;
}

export function buildApp(config: AppConfig, options: BuildOptions = {}): FastifyInstance {
  if (config.NODE_ENV === "production" && (config.logLevel === "debug" || config.logLevel === "trace")) {
    throw new Error("refus de démarrer : journal de débogage interdit");
  }
  assertPasswordMinLength(config.PASSWORD_MIN_LENGTH);
  const stream = options.logStream ?? process.stdout;
  const app = Fastify({
    bodyLimit: config.bodyLimit,
    trustProxy: false,
    logController: new LogController({ disableRequestLogging: true }),
    logger: {
      level: config.logLevel,
      stream,
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "req.headers.set-cookie",
          "password",
          "token",
          "secret",
          "title",
          "content",
          "body",
          "err.message",
          "err.stack",
        ],
        remove: true,
      },
    },
  });

  trackRoutes(app);
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    const text = typeof body === "string" ? body : "";
    if (text.trim().length === 0) {
      if (request.method === "DELETE") {
        done(null, undefined);
        return;
      }
      done(Object.assign(new Error("corps vide"), { statusCode: 400 }), undefined);
      return;
    }
    try {
      done(null, JSON.parse(text) as unknown);
    } catch {
      done(Object.assign(new Error("json"), { statusCode: 400 }), undefined);
    }
  });
  registerAuth(app, config, { ...options, logStream: stream });

  app.addHook("onRequest", async (request, reply) => {
    const length = Number(headerValue(request.headers["content-length"]));
    if (Number.isFinite(length) && length > config.bodyLimit) {
      return sendProblem(reply, 413);
    }
    return undefined;
  });

  app.addHook("preValidation", async (request, reply) => {
    const body = request.body;
    if (body === null || body === undefined || typeof body !== "object" || Array.isArray(body)) {
      return undefined;
    }
    if (Buffer.isBuffer(body)) {
      return undefined;
    }
    const record = body as Record<string, unknown>;
    const routeUrl = request.routeOptions.url ?? "";
    const documentRoute = routeUrl === "/api/v1/documents" || routeUrl.startsWith("/api/v1/documents/");
    const keepClientId = request.method === "POST" && routeUrl === "/api/v1/documents";
    for (const key of SERVER_ASSIGNED_KEYS) {
      if (keepClientId && key === "id") {
        continue;
      }
      delete record[key];
    }
    if (!documentRoute && "title" in record && !documentTitleSchema.safeParse(record.title).success) {
      return sendProblem(reply, 400);
    }
    return undefined;
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("cache-control", "no-store");
    reply.removeHeader("x-powered-by");
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    const statusCode =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    const status = publicStatus(statusCode);
    if (status >= 500) {
      writeSecurityLog(stream, {
        type: "server_error",
        result: "echec",
        ip: clientIp(request, config.TRUSTED_PROXY_CIDR),
        userAgent: headerValue(request.headers["user-agent"]) ?? null,
      });
    }
    return sendProblem(reply, status);
  });

  app.setNotFoundHandler(async (request, reply) => {
    const decision = await anonymousRequest(app, request);
    if (decision.kind === "anonymous") {
      return sendProblem(reply, 401);
    }
    return sendProblem(reply, 404);
  });

  app.get("/api/v1/healthz", async (request, reply) => {
    if (!healthQuerySchema.safeParse(request.query).success) {
      return sendProblem(reply, 400);
    }
    return { status: "ok" as const };
  });

  return app;
}

export function createAppPool(config: AppConfig, password: string): Pool {
  return new Pool({
    host: config.DATABASE_HOST,
    port: config.DATABASE_PORT ?? 5432,
    database: config.DATABASE_NAME,
    user: config.DATABASE_USER,
    password,
    max: 10,
    connectionTimeoutMillis: 3000,
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function connectAppPool(config: AppConfig, password: string): Promise<Pool> {
  const deadline = Date.now() + 45_000;
  let last = "base injoignable";
  while (Date.now() < deadline) {
    const pool = createAppPool(config, password);
    try {
      const client = await pool.connect();
      await client.query("SELECT 1");
      client.release();
      return pool;
    } catch (error) {
      last = error instanceof Error ? error.message : "echec";
      await pool.end().catch(() => undefined);
      await delay(1000);
    }
  }
  throw new Error(`refus de démarrer : ${last}`);
}

export async function notifyStartupRefusal(config: AppConfig, stream: Writable, message: string): Promise<void> {
  writeSecurityLog(stream, { type: "server_error", result: "echec", ip: null, userAgent: null });
  if (config.ALERT_WEBHOOK_URL !== "") {
    await fetch(config.ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: message,
    }).catch(() => undefined);
  }
}

export async function assertAppPool(pool: Pool, alert: (message: string) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await assertAppRole(client as unknown as Client);
  } catch (error) {
    const message = error instanceof Error ? error.message : "refus de démarrer : rôle applicatif non conforme";
    await alert(message.startsWith("refus de démarrer") ? message : "refus de démarrer : rôle applicatif non conforme");
    throw error;
  } finally {
    client.release();
  }
}

async function start(config: AppConfig, secrets: LoadedSecrets): Promise<void> {
  const pool = await connectAppPool(config, secrets.databasePassword);
  try {
    await assertAppPool(pool, async (message) => {
      await notifyStartupRefusal(config, process.stderr, message);
      console.error(message);
    });
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
  const app = buildApp(config, { pool, secrets });
  try {
    await whenAuthReady(app);
    // Sans connexion (local), le serveur n'écoute que cette machine : jamais le réseau.
    const localOnly = config.NODE_ENV === "development" && process.env.FLAW_DEV_NO_AUTH === "true";
    await app.listen({ host: localOnly ? "127.0.0.1" : "0.0.0.0", port: config.PORT });
    schedulePurge(pool, config);
  } catch {
    await pool.end().catch(() => undefined);
    throw new Error("refus de démarrer : écoute impossible");
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Purge quotidienne des journaux (T-042, § 7.8) : flaw.purge_journaux(), consignée
 * dans audit_events pour chaque administrateur (sans contenu) ; échec = alerte.
 */
function schedulePurge(pool: Pool, config: AppConfig): void {
  const run = async (): Promise<void> => {
    const ownerId = await firstAdminId(pool);
    try {
      if (ownerId === undefined) {
        await pool.query("SELECT flaw.purge_journaux()");
      } else {
        await consignerResultatPurge({
          // Relais typé : consignerResultatPurge ne lui passe que des requêtes littérales paramétrées.
          query: (sql, params) => pool.query(sql, [...params]), // nosemgrep: sec-db-03-query-non-literal, sec-db-03-taint
          purge: async () => {
            await pool.query("SELECT flaw.purge_journaux()");
          },
          ownerId,
        });
      }
      process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), type: "purge_journaux", result: "succes" })}\n`);
    } catch {
      await notifyStartupRefusal(config, process.stderr, "purge des journaux en échec").catch(() => undefined);
    }
  };
  void run().catch(() => undefined);
  setInterval(() => {
    void run().catch(() => undefined);
  }, DAY_MS).unref();
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  const loaded = loadConfig(process.env);
  if (!loaded.ok) {
    console.error(loaded.message);
    process.exit(1);
  }
  holdSecrets(loaded.secrets);
  start(loaded.config, loaded.secrets).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "echec";
    console.error(message.startsWith("refus de démarrer") ? message : "refus de démarrer");
    process.exit(1);
  });
}
