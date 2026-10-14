/**
 * Squelette Fastify (T-004) : configuration, erreurs RFC 9457, santé, journal.
 * Les secrets passent par loadSecrets → readSecretFile (validateur T-002).
 * Le processus de l'image Docker reste src/platform/healthz.ts (T-002).
 */
import { Buffer } from "node:buffer";
import { type Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import Fastify, { LogController, type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";

import { holdSecrets, loadConfig, type AppConfig } from "./config/load.ts";
import { resolvedClientIp } from "./platform/healthz.ts";
import { sendProblem, type ProblemStatus } from "./platform/problem.ts";
import { writeSecurityLog } from "./platform/security-log.ts";
import { documentTitleSchema, SERVER_ASSIGNED_KEYS } from "./platform/validation.ts";

const healthQuerySchema = z.object({}).strict();

export type BuildOptions = {
  logStream?: Writable;
};

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
    for (const key of SERVER_ASSIGNED_KEYS) {
      delete record[key];
    }
    if ("title" in record && !documentTitleSchema.safeParse(record.title).success) {
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

  app.setNotFoundHandler((_request, reply) => {
    return sendProblem(reply, 404);
  });

  app.get("/api/v1/healthz", async (request, reply) => {
    if (!healthQuerySchema.safeParse(request.query).success) {
      return sendProblem(reply, 400);
    }
    return {
      status: "ok" as const,
      clientIp: clientIp(request, config.TRUSTED_PROXY_CIDR),
    };
  });

  return app;
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
  const app = buildApp(loaded.config);
  app.listen({ host: "0.0.0.0", port: loaded.config.PORT }).catch(() => {
    console.error("refus de démarrer : écoute impossible");
    process.exit(1);
  });
}
