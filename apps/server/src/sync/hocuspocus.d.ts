/**
 * Types d'attente pour @hocuspocus/server et yjs.
 * Retirés quand ces paquets entrent dans le lockfile (après T-017).
 * Ce n'est pas une copie des bibliothèques.
 */
declare module "yjs" {
  export class Doc {
    getMap(name: string): { get(key: string): unknown };
    destroy(): void;
  }
  export function applyUpdate(doc: Doc, update: Uint8Array, origin?: unknown): void;
  export function encodeStateAsUpdate(doc: Doc, encodedStateVector?: Uint8Array): Uint8Array;
  export function mergeUpdates(updates: Uint8Array[]): Uint8Array;
}

declare module "@hocuspocus/server" {
  import type { IncomingMessage } from "node:http";
  import type { Socket } from "node:net";
  import type { Doc } from "yjs";

  export type HookContext = {
    userId?: string;
    timer?: ReturnType<typeof setInterval>;
  };

  export type SyncHooks = {
    onAuthenticate?: (data: {
      documentName: string;
      requestHeaders: IncomingMessage["headers"];
      connection: { close: () => void };
    }) => Promise<HookContext>;
    onLoadDocument?: (data: { documentName: string; context: HookContext; document: Doc }) => Promise<void>;
    onChange?: (data: { documentName: string; context: HookContext; update: Uint8Array; connection: { close: () => void } }) => Promise<void>;
    onStoreDocument?: (data: { documentName: string; context: HookContext; document: Doc }) => Promise<void>;
    onDisconnect?: (data: { context: HookContext }) => Promise<void>;
  };

  export class Hocuspocus {
    constructor(options: SyncHooks);
    handleConnection(request: IncomingMessage, socket: Socket, head: Buffer): void;
  }
}
