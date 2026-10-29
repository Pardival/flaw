/**
 * WSS /api/v1/sync (API-024) : protocole Hocuspocus multiplexé, un Y.Doc par texte.
 * Handshake : Origin autorisée et cookie de session complète (SEC-API-06) ; chaque texte
 * est contrôlé comme en REST ; session revalidée toutes les 30 s ; journal chiffré à
 * chaque mise à jour, compaction et projection après 2 s de calme (10 s au plus).
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { Hocuspocus, type onChangePayload, type onConnectPayload, type onLoadDocumentPayload, type onStoreDocumentPayload } from "@hocuspocus/server";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { WebSocketServer, type WebSocket } from "ws";
import * as Y from "yjs";

import type { AccessActor } from "../access/can.ts";
import { withActor } from "../access/scope.ts";
import { readCookie, SESSION_COOKIE } from "../auth/cookie.ts";
import {
  SYNC_CLOSE_UNAUTHORIZED,
  SYNC_PATH,
  SYNC_REVALIDATE_MS,
  SYNC_SCHEMA_PARAM,
  clientTooOld,
  parseSchemaHeader,
} from "../../../../packages/sync/src/index.ts";
import { SCHEMA_VERSION } from "@flaw/schema/src/index.ts";
import { liveDocuments } from "./journal.ts";
import { LOAD_ORIGIN, appendUpdate, compact, loadInto, maySync } from "./persistence.ts";

export type SyncSession = { userId: string; role: "user" | "admin" };

export type SyncDeps = {
  pool: () => Pool | undefined;
  kek: () => Uint8Array | undefined;
  /** Session complète (non restreinte) du jeton, ou null. */
  resolve: (token: string) => Promise<SyncSession | null>;
  origins: () => Set<string>;
  maxPayload: number;
};

type Context = { actor: AccessActor };

function isStorageOrigin(origin: unknown): boolean {
  return origin === LOAD_ORIGIN;
}

function refuse(socket: Duplex, status: 401 | 403 | 404): void {
  const text = status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Not Found";
  socket.end(`HTTP/1.1 ${String(status)} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function headersOf(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") {
      headers.set(name, value);
    } else if (Array.isArray(value)) {
      headers.set(name, value.join(", "));
    }
  }
  return headers;
}

export function attachSync(app: FastifyInstance, deps: SyncDeps): Hocuspocus<Context> {
  const required = (): { pool: Pool; kek: Uint8Array } => {
    const pool = deps.pool();
    const kek = deps.kek();
    if (pool === undefined || kek === undefined) {
      throw new Error("synchronisation indisponible");
    }
    return { pool, kek };
  };

  const hocuspocus = new Hocuspocus<Context>({
    name: "flaw",
    debounce: 2_000,
    maxDebounce: 10_000,
    quiet: true,
    async onConnect(data: onConnectPayload<Context>) {
      const { pool } = required();
      const actor = data.context.actor;
      const allowed = await withActor(pool, actor.userId, (sql) => maySync(sql, actor, data.documentName));
      if (!allowed) {
        throw new Error("texte inaccessible");
      }
      // Client plus ancien que le schéma : lecture seule (équivalent WS du 426).
      const client = parseSchemaHeader(data.requestParameters.get(SYNC_SCHEMA_PARAM) ?? undefined);
      if (clientTooOld(client, SCHEMA_VERSION)) {
        data.connectionConfig.readOnly = true;
      }
    },
    async onLoadDocument(data: onLoadDocumentPayload<Context>) {
      const { pool, kek } = required();
      const loaded = await loadInto(pool, data.context.actor, kek, data.documentName, data.document);
      if (!loaded) {
        throw new Error("texte illisible");
      }
      const document = data.document;
      liveDocuments.set(data.documentName, (update) => {
        Y.applyUpdate(document, update, LOAD_ORIGIN);
      });
      return document;
    },
    async onChange(data: onChangePayload<Context>) {
      if (isStorageOrigin(data.transactionOrigin)) {
        return;
      }
      const actor = data.context?.actor;
      if (actor === undefined) {
        return;
      }
      const { pool, kek } = required();
      if (!(await appendUpdate(pool, actor, kek, data.documentName, data.update))) {
        throw new Error("journal indisponible");
      }
    },
    async onStoreDocument(data: onStoreDocumentPayload<Context>) {
      const actor = data.lastContext?.actor;
      if (actor === undefined) {
        return;
      }
      const { pool, kek } = required();
      await compact(pool, actor, kek, data.documentName, data.document);
    },
    async afterUnloadDocument(data) {
      liveDocuments.delete(data.documentName);
    },
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: deps.maxPayload });

  app.server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? "/", "http://flaw.invalid");
    if (url.pathname !== SYNC_PATH) {
      refuse(socket, 404);
      return;
    }
    const origin = request.headers.origin;
    if (origin === undefined || !deps.origins().has(origin)) {
      refuse(socket, 403);
      return;
    }
    if ([...url.searchParams.keys()].some((key) => key.toLowerCase() === "token")) {
      refuse(socket, 401);
      return;
    }
    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    if (token === undefined) {
      refuse(socket, 401);
      return;
    }
    deps.resolve(token).then(
      (session) => {
        if (session === null) {
          refuse(socket, 401);
          return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => {
          accept(ws, request, url, token, session);
        });
      },
      () => {
        refuse(socket, 401);
      },
    );
  });

  function accept(ws: WebSocket, request: IncomingMessage, url: URL, token: string, session: SyncSession): void {
    const fetchRequest = new Request(url.toString(), { headers: headersOf(request) });
    const connection = hocuspocus.handleConnection(ws, fetchRequest, {
      actor: { userId: session.userId, role: session.role },
    });
    ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      connection.handleMessage(new Uint8Array(bytes));
    });
    ws.on("pong", () => {
      connection.touch();
    });
    // Revalidation : révocation ou expiration → fermeture en moins de 60 s.
    const timer = setInterval(() => {
      deps.resolve(token).then(
        (current) => {
          if (current === null || current.userId !== session.userId) {
            ws.close(SYNC_CLOSE_UNAUTHORIZED, "session");
          } else {
            ws.ping();
          }
        },
        () => {
          ws.close(SYNC_CLOSE_UNAUTHORIZED, "session");
        },
      );
    }, SYNC_REVALIDATE_MS);
    ws.on("close", (code: number, reason: Buffer) => {
      clearInterval(timer);
      connection.handleClose({ code, reason: reason.toString() } as CloseEvent);
    });
  }

  app.addHook("onClose", async () => {
    hocuspocus.flushPendingStores();
    for (const client of wss.clients) {
      client.close(1001, "arrêt");
    }
    wss.close();
  });

  return hocuspocus;
}
