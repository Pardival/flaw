/**
 * WebSocket Hocuspocus sur /api/v1/sync.
 * Non branché : yjs et @hocuspocus/server ne sont pas des dépendances
 * tant que T-017 n'a pas fait passer le lockfile. createSyncServer n'est
 * pas appelé au démarrage.
 */
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";

import { messageTooLarge, revalidationDelayMs, SYNC_PATH, upgradeRefusal } from "./upgrade.ts";

export type SyncRuntime = {
  allowedOrigins: ReadonlySet<string>;
  revalidateSeconds: number;
  maxMessageBytes: number;
  documentSchema: (userId: string, documentId: string) => Promise<number | undefined>;
  authenticate: (cookieHeader: string | undefined, documentId: string) => Promise<{ userId: string } | undefined>;
  loadUpdates: (userId: string, documentId: string) => Promise<Uint8Array[]>;
  storeUpdate: (userId: string, documentId: string, update: Uint8Array) => Promise<void>;
  project?: (userId: string, documentId: string, meta: { title: unknown; schemaVersion: unknown }) => Promise<void>;
};

function header(headers: IncomingMessage["headers"], name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function refuse(socket: Socket, status: 403 | 426): void {
  const reason = status === 426 ? "Upgrade Required" : "Forbidden";
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export async function createSyncServer(runtime: SyncRuntime): Promise<{
  handleUpgrade: (request: IncomingMessage, socket: Socket, head: Buffer) => void;
}> {
  const [{ Hocuspocus }, Y] = await Promise.all([import("@hocuspocus/server"), import("yjs")]);
  const server = new Hocuspocus({
    async onAuthenticate({ documentName, requestHeaders, connection }) {
      const user = await runtime.authenticate(header(requestHeaders, "cookie"), documentName);
      if (user === undefined) {
        connection.close();
        throw new Error("unauthorized");
      }
      const schema = (await runtime.documentSchema(user.userId, documentName)) ?? 1;
      const refusal = upgradeRefusal(
        {
          path: SYNC_PATH,
          origin: header(requestHeaders, "origin"),
          schemaHeader: header(requestHeaders, "x-flaw-schema-version"),
          documentSchema: schema,
        },
        runtime.allowedOrigins,
      );
      if (refusal !== undefined) {
        connection.close();
        throw new Error(refusal === 426 ? "upgrade_required" : "forbidden");
      }
      const timer = setInterval(() => {
        void runtime.authenticate(header(requestHeaders, "cookie"), documentName).then((still) => {
          if (still === undefined) {
            connection.close();
          }
        });
      }, revalidationDelayMs(runtime.revalidateSeconds));
      timer.unref();
      return { userId: user.userId, timer };
    },
    async onLoadDocument({ documentName, context, document }) {
      if (context.userId === undefined) {
        return;
      }
      const updates = await runtime.loadUpdates(context.userId, documentName);
      if (updates.length === 0) {
        return;
      }
      Y.applyUpdate(document, Y.mergeUpdates(updates), "load");
    },
    async onChange({ update, connection, context }) {
      if (context.userId === undefined || messageTooLarge(update.byteLength, runtime.maxMessageBytes)) {
        connection.close();
        throw new Error(context.userId === undefined ? "unauthorized" : "payload_too_large");
      }
    },
    async onStoreDocument({ documentName, context, document }) {
      if (context.userId === undefined) {
        return;
      }
      const state = Y.encodeStateAsUpdate(document);
      if (messageTooLarge(state.byteLength, runtime.maxMessageBytes)) {
        return;
      }
      await runtime.storeUpdate(context.userId, documentName, state);
      const meta = document.getMap("meta");
      if (runtime.project !== undefined) {
        await runtime.project(context.userId, documentName, {
          title: meta.get("title"),
          schemaVersion: meta.get("schemaVersion"),
        });
      }
    },
    async onDisconnect({ context }) {
      if (context.timer !== undefined) {
        clearInterval(context.timer);
      }
    },
  });

  return {
    handleUpgrade(request, socket, head) {
      const path = (request.url ?? "").split("?", 1)[0] ?? "";
      const refusal = upgradeRefusal(
        {
          path,
          origin: header(request.headers, "origin"),
          schemaHeader: header(request.headers, "x-flaw-schema-version"),
          documentSchema: 1,
        },
        runtime.allowedOrigins,
      );
      if (refusal !== undefined) {
        refuse(socket, refusal);
        return;
      }
      server.handleConnection(request, socket, head);
    },
  };
}
