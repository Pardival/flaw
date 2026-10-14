import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { buildApp, type BuildOptions } from "../app.ts";
import type { AppConfig } from "../config/load.ts";
import { omitServerAssigned, parseStrict } from "./validation.ts";
import { z } from "zod";

const PHRASE = "PHRASEMARQUEURINÉDITE";
const PASSWORD = "MOTDEPASSEMARQUEUR9f3a";
const root = fileURLToPath(new URL("../../../../", import.meta.url));

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    NODE_ENV: "test",
    LOG_LEVEL: "info",
    logLevel: "info",
    PORT: 3000,
    TRUSTED_ORIGINS: "",
    TRUSTED_PROXY_CIDR: "172.31.250.10/32",
    DATABASE_HOST: "db",
    DATABASE_NAME: "flaw",
    DATABASE_USER: "flaw_app",
    FLAW_KEK_ID: "kek-2026-10",
    RECOVERY_PEPPER_ID: "pep-2026-10",
    RECOVERY_PEPPER_OLD_IDS: "",
    ALLOW_SIGNUP: "false",
    allowSignup: false,
    SESSION_IDLE_DAYS: 30,
    SESSION_MAX_DAYS: 90,
    SESSION_REVALIDATE_SECONDS: 30,
    MAX_DOCUMENT_SIZE_MB: 10,
    MAX_WS_MESSAGE_MB: 10,
    EXPORT_TIMEOUT_SECONDS: 60,
    EXPORT_MAX_CONCURRENCY: 1,
    EXPORT_MAX_RSS_MB: 900,
    PASSWORD_MIN_LENGTH: 15,
    SNAPSHOT_RETENTION_DAYS: 30,
    ALERT_WEBHOOK_URL: "",
    bodyLimit: 10 * 1024 * 1024,
    ...overrides,
  };
}

function appWithLogs(overrides: Partial<AppConfig> = {}, options: BuildOptions = {}) {
  const stream = new PassThrough();
  let text = "";
  stream.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
  });
  const app = buildApp(config(overrides), { logStream: stream, ...options });
  return {
    app,
    logs: () => text,
  };
}

function headerNames(headers: Record<string, unknown>): string[] {
  return Object.keys(headers).map((name) => name.toLowerCase());
}

describe("API-023 santé", () => {
  it("répond 200 sans authentification, en no-store, avec l'IP résolue", async () => {
    const { app } = appWithLogs();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/healthz",
      remoteAddress: "172.31.250.10",
      headers: { "x-real-ip": "203.0.113.9" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", clientIp: "203.0.113.9" });
    expect(response.headers["cache-control"]).toBe("no-store");
    await app.close();
  });

  it("ignore un X-Real-IP forgé", async () => {
    const { app } = appWithLogs();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/healthz",
      remoteAddress: "203.0.113.4",
      headers: { "x-real-ip": "198.51.100.8" },
    });
    expect(response.json()).toEqual({ status: "ok", clientIp: "203.0.113.4" });
    await app.close();
  });
});

describe("SEC-WEB-10 et SEC-WEB-11", () => {
  it("n'émet aucun en-tête CORS, même avec Origin", async () => {
    const { app } = appWithLogs();
    for (const url of ["/api/v1/healthz", "/api/v1/documents"]) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: { origin: "https://evil.example" },
      });
      const names = headerNames(response.headers);
      expect(names.some((name) => name.startsWith("access-control-allow"))).toBe(false);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(names).not.toContain("x-powered-by");
      expect(names).not.toContain("server");
    }
    await app.close();
  });

  it("renvoie une erreur 500 générique, sans pile ni version", async () => {
    const { app, logs } = appWithLogs();
    app.get("/api/v1/__erreur", async () => {
      throw new Error(`SELECT ${PHRASE} FROM users WHERE password = '${PASSWORD}' at /opt/flaw/app.ts fastify Zod`);
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/__erreur?debug=1",
      headers: {
        "x-debug": "1",
        authorization: `Bearer ${PASSWORD}`,
        cookie: `session=${PASSWORD}`,
        "user-agent": `Nav ${PHRASE}`,
      },
    });
    const body = response.body;
    expect(response.statusCode).toBe(500);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.json()).toEqual({
      type: "about:blank",
      status: 500,
      title: "Erreur interne",
      code: "internal_error",
    });
    expect(body).not.toContain(PHRASE);
    expect(body).not.toContain(PASSWORD);
    expect(body).not.toContain("SELECT");
    expect(body).not.toContain("/opt/flaw");
    expect(body).not.toContain("fastify");
    expect(body).not.toContain("Zod");
    expect(body).not.toContain("0.0.0");
    expect(logs()).not.toContain(PHRASE);
    expect(logs()).not.toContain(PASSWORD);
    expect(logs()).toContain("\"type\":\"server_error\"");
    expect(logs()).toContain("\"result\":\"echec\"");
    await app.close();
  });

  it("interdit le niveau debug en production au moment de construire l'application", () => {
    expect(() => buildApp(config({ NODE_ENV: "production", LOG_LEVEL: "debug", logLevel: "debug" }))).toThrow(
      /journal de débogage interdit/,
    );
  });
});

describe("SEC-API-03", () => {
  it("refuse une charge de 11 Mio", async () => {
    const { app } = appWithLogs();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/healthz",
      headers: {
        "content-type": "application/json",
        "content-length": String(11 * 1024 * 1024),
        origin: "https://evil.example",
      },
      payload: "x",
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ status: 413, code: "payload_too_large" });
    expect(headerNames(response.headers).some((name) => name.startsWith("access-control-allow"))).toBe(false);
    await app.close();
  });

  it("refuse un champ inconnu ou un type erroné", async () => {
    const { app } = appWithLogs();
    const unknown = await app.inject({ method: "GET", url: "/api/v1/healthz?traceur=1" });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ code: "invalid_request" });
    const parsed = parseStrict(z.object({ title: z.string().max(300) }).strict(), {
      title: 12,
      inconnu: true,
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.status).toBe(400);
      expect(parsed.body.code).toBe("invalid_request");
    }
    await app.close();
  });

  it("refuse un titre de 301 caractères", async () => {
    const { app } = appWithLogs();
    app.post("/api/v1/__corps", async (request) => {
      return { keys: Object.keys(request.body as object).sort() };
    });
    const tooLong = await app.inject({
      method: "POST",
      url: "/api/v1/__corps",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ title: "a".repeat(301) }),
    });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json()).toMatchObject({ code: "invalid_request" });
    expect(tooLong.body).not.toContain("a".repeat(301));
    const wrongType = await app.inject({
      method: "POST",
      url: "/api/v1/__corps",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ title: 301 }),
    });
    expect(wrongType.statusCode).toBe(400);
    const accepted = await app.inject({
      method: "POST",
      url: "/api/v1/__corps",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ title: "a".repeat(300) }),
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ keys: ["title"] });
    await app.close();
  });
});

describe("SEC-API-07 et AC-096", () => {
  it("ignore id, owner_id, dates et révision fournis par le client", async () => {
    const input = {
      title: "Chapitre",
      id: "imposé",
      owner_id: "autre-compte",
      created_at: "2000-01-01",
      updated_at: "2000-01-02",
      revision: 4,
    };
    expect(omitServerAssigned(input)).toEqual({ title: "Chapitre" });
    const { app } = appWithLogs();
    app.post("/api/v1/__corps", async (request) => {
      return request.body;
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/__corps",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify(input),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ title: "Chapitre" });
    expect(response.body).not.toContain("autre-compte");
    await app.close();
  });
});

describe("AC-102", () => {
  it("ne référence aucun traceur et n'appelle pas le réseau pour la sonde", async () => {
    const banned = ["google-analytics", "googletagmanager", "segment.io", "plausible.io", "doubleclick.net"];
    const files = walk(join(root, "apps/server/src")).filter(
      (file) => file.endsWith(".ts") && !file.endsWith(".test.ts"),
    );
    const source = files.map((file) => readFileSync(file, "utf8")).join("\n");
    for (const host of banned) {
      expect(source).not.toContain(host);
    }
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      calls.push(String(input));
      return original(input, init);
    }) as typeof fetch;
    try {
      const { app } = appWithLogs();
      const response = await app.inject({ method: "GET", url: "/api/v1/healthz" });
      expect(response.statusCode).toBe(200);
      expect(calls).toEqual([]);
      await app.close();
    } finally {
      globalThis.fetch = original;
    }
  });
});

function walk(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      files.push(...walk(path));
    } else {
      files.push(path);
    }
  }
  return files;
}
