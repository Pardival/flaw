import "fake-indexeddb/auto";

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { LocalDatabase } from "./db.ts";
import { isSafeDocumentPath } from "./guards.ts";
import {
  DEFAULT_TITLE,
  DOCUMENT_MODES,
  LOGOUT_WARNING,
  PAGE_FORMATS,
  QUOTA_RETRY_MS,
  SCHEMA_VERSION,
  openLocalStore,
  type LocalStore,
  type LocalStoreOptions,
  type StoreEvent,
} from "./index.ts";
import { isUuidV7 } from "./uuid.ts";

const opened: LocalStore[] = [];

afterEach(async () => {
  for (const store of opened.splice(0)) {
    await store.close().catch(() => undefined);
  }
});

let serial = 0;

function nextDatabaseName(): string {
  serial += 1;
  return `flaw-test-${serial}`;
}

async function harness(options: LocalStoreOptions = {}): Promise<{ store: LocalStore; databaseName: string }> {
  const databaseName = options.databaseName ?? nextDatabaseName();
  const store = await openLocalStore({ ...options, databaseName });
  opened.push(store);
  return { store, databaseName };
}

function clock(start = "2026-01-01T00:00:00.000Z"): { now: () => Date; advance: (millis: number) => void } {
  let millis = Date.parse(start);
  return {
    now: () => new Date(millis),
    advance(step: number) {
      millis += step;
    },
  };
}

function quotaError(): DOMException {
  return new DOMException("quota", "QuotaExceededError");
}

describe("stockage local", () => {
  it("aligne modes, formats et version de schéma sur main", () => {
    const root = fileURLToPath(new URL("../../../../", import.meta.url));
    const constants = readFileSync(join(root, "packages/schema/src/constants.ts"), "utf8");
    const api = readFileSync(join(root, "apps/server/src/documents/schema.ts"), "utf8");
    expect(constants).toContain(`export const DOCUMENT_MODES = [${DOCUMENT_MODES.map((mode) => JSON.stringify(mode)).join(", ")}] as const;`);
    expect(constants).toContain(`export const SCHEMA_VERSION = ${SCHEMA_VERSION};`);
    expect(api).toContain(`export const MODES = [${DOCUMENT_MODES.map((mode) => JSON.stringify(mode)).join(", ")}] as const;`);
    expect(api).toContain(`export const PAGE_FORMATS = [${PAGE_FORMATS.map((format) => JSON.stringify(format)).join(", ")}] as const;`);
    expect(api).toContain("min(6).max(48)");
    const dir = fileURLToPath(new URL(".", import.meta.url));
    const source = readdirSync(dir)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => readFileSync(join(dir, name), "utf8"))
      .join("\n");
    expect(source).not.toContain("localStorage");
    expect(source).not.toContain("sessionStorage");
    expect(source).not.toContain("innerHTML");
    expect(source).toContain("QUOTA_RETRY_MS");
    expect(QUOTA_RETRY_MS).toBe(60_000);
  });

  it("crée un texte « Sans titre », le renomme et trie la liste par dernière modification", async () => {
    const time = clock();
    const { store } = await harness({ now: time.now });
    const untitled = await store.createDocument({ mode: "novel", pageFormat: "novel_13x20" });
    expect(untitled.title).toBe(DEFAULT_TITLE);
    expect(untitled.mode).toBe("novel");
    expect(untitled.pageFormat).toBe("novel_13x20");
    expect(isUuidV7(untitled.id)).toBe(true);
    expect(untitled.schemaVersion).toBe(SCHEMA_VERSION);
    expect(untitled).not.toHaveProperty("folder");
    expect(untitled).not.toHaveProperty("project");
    const blank = await store.createDocument({ mode: "blank", pageFormat: "a4", title: "" });
    expect(blank.title).toBe("");
    time.advance(60_000);
    const renamed = await store.renameDocument(untitled.id, "Chapitre");
    expect(renamed.title).toBe("Chapitre");
    time.advance(60_000);
    const recent = await store.createDocument({ mode: "screenplay", pageFormat: "us_letter", title: "Scène" });
    expect((await store.listDocuments()).map((item) => item.id)).toEqual([recent.id, untitled.id, blank.id]);
    await expect(store.createDocument({ mode: "roman" as "novel", pageFormat: "a4" })).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(
      store.createDocument({ id: crypto.randomUUID(), mode: "document", pageFormat: "a4" }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(store.renameDocument(untitled.id, "a".repeat(301))).rejects.toMatchObject({ code: "invalid" });
  });

  it("demande une confirmation (Annuler) avant la corbeille et la suppression définitive", async () => {
    const { store } = await harness();
    const doc = await store.createDocument({ mode: "document", pageFormat: "a4", title: "À garder" });
    const ask = await store.requestTrash(doc.id);
    expect(ask.defaultFocus).toBe("cancel");
    expect(ask.confirmationRequired).toBe(true);
    expect(await store.listDocuments()).toHaveLength(1);
    await expect(store.confirmTrash(doc.id, "absent")).rejects.toMatchObject({ code: "confirmation" });
    const trashed = await store.confirmTrash(doc.id, ask.confirmationId);
    expect(trashed.deletedAt).not.toBeNull();
    expect(await store.listDocuments()).toEqual([]);
    expect(await store.listTrash()).toEqual([expect.objectContaining({ id: doc.id })]);
    await expect(store.requestPermanentDelete(doc.id)).resolves.toMatchObject({ defaultFocus: "cancel" });
    const fresh = await store.createDocument({ mode: "blank", pageFormat: "a5" });
    await expect(store.requestPermanentDelete(fresh.id)).rejects.toMatchObject({ code: "invalid" });
    const permanent = await store.requestPermanentDelete(doc.id);
    await store.confirmPermanentDelete(doc.id, permanent.confirmationId);
    expect(await store.listTrash()).toEqual([]);
    const restoredSource = await store.createDocument({ mode: "novel", pageFormat: "a5", title: "Retour" });
    const trash = await store.requestTrash(restoredSource.id);
    await store.confirmTrash(restoredSource.id, trash.confirmationId);
    const restored = await store.restoreDocument(restoredSource.id);
    expect(restored.deletedAt).toBeNull();
    expect(await store.listDocuments()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: restoredSource.id, title: "Retour" })]),
    );
  });

  it("enregistre tout seul, rouvre le curseur et ne perd rien à la fermeture", async () => {
    const name = nextDatabaseName();
    const first = await openLocalStore({ databaseName: name });
    opened.push(first);
    const doc = await first.createDocument({ mode: "novel", pageFormat: "pocket_11x17_8" });
    await first.insertText(doc.id, 0, "abcdef");
    await first.setCursor(doc.id, 3);
    await first.insertText(doc.id, 0, "XY");
    expect(await first.readText(doc.id)).toBe("XYabcdef");
    expect(await first.cursorIndex(doc.id)).toBe(5);
    expect((await first.listDocuments())[0]?.wordCount).toBe(1);
    const probe = new LocalDatabase(name);
    await probe.open();
    expect(await probe.counters.get(doc.id)).toEqual({ id: doc.id, wordCount: 1 });
    probe.close();
    await first.close();
    const second = await openLocalStore({ databaseName: name });
    opened.push(second);
    expect(await second.readText(doc.id)).toBe("XYabcdef");
    expect(await second.reopenLast()).toEqual({ id: doc.id, index: 5 });
    const names = (await indexedDB.databases()).map((item) => item.name);
    expect(names).toContain(doc.id);
    expect(names.some((item) => item?.includes("abcdef"))).toBe(false);
  });

  it("garde l'écriture hors ligne et rejoue la même clé d'idempotence", async () => {
    const name = nextDatabaseName();
    const store = await openLocalStore({ databaseName: name });
    opened.push(store);
    const doc = await store.createDocument({ mode: "novel", pageFormat: "a5", title: "Hors ligne" });
    await store.insertText(doc.id, 0, "coupure réseau");
    expect(await store.hasUnsynced()).toBe(true);
    const first: string[] = [];
    const stopped = await store.flush(async (operation) => {
      first.push(operation.idempotencyKey);
      expect(operation.headers["idempotency-key"]).toBe(operation.idempotencyKey);
      expect(operation.idempotencyKey.length).toBeLessThanOrEqual(128);
      expect(isSafeDocumentPath(operation.path)).toBe(true);
      expect(operation.path).not.toContain("Hors ligne");
      expect(Object.keys(operation.headers).every((key) => key === "idempotency-key" || key === "x-flaw-schema-version")).toBe(
        true,
      );
      throw new Error("offline");
    });
    expect(stopped).toEqual({ sent: 0, stopped: true });
    await store.close();
    const reopened = await openLocalStore({ databaseName: name });
    opened.push(reopened);
    expect(await reopened.readText(doc.id)).toBe("coupure réseau");
    expect(await reopened.hasUnsynced()).toBe(true);
    const second: string[] = [];
    const done = await reopened.flush(async (operation) => {
      second.push(operation.idempotencyKey);
      if (operation.path.endsWith("/sync")) {
        expect(operation.headers["x-flaw-schema-version"]).toBe(String(SCHEMA_VERSION));
        const body = JSON.parse(operation.body ?? "{}") as { update?: string; stateVector?: string };
        expect(typeof body.update).toBe("string");
        expect(typeof body.stateVector).toBe("string");
      }
    });
    expect(done.stopped).toBe(false);
    expect(second[0]).toBe(first[0]);
    expect(new Set(second).size).toBe(second.length);
    expect(await reopened.hasUnsynced()).toBe(false);
    expect(await reopened.pendingOperations()).toEqual([]);
  });

  it("fusionne deux appareils sans perdre de texte", async () => {
    const phone = await harness();
    const desk = await harness();
    const shared = (await phone.store.createDocument({ mode: "novel", pageFormat: "trade_15x23" })).id;
    await desk.store.createDocument({ id: shared, mode: "novel", pageFormat: "trade_15x23" });
    await phone.store.insertText(shared, 0, "AAA");
    await desk.store.insertText(shared, 0, "BBB");
    await phone.store.importUpdate(shared, await desk.store.exportUpdate(shared));
    await desk.store.importUpdate(shared, await phone.store.exportUpdate(shared));
    const merged = await phone.store.readText(shared);
    expect(merged).toBe(await desk.store.readText(shared));
    expect(merged).toContain("AAA");
    expect(merged).toContain("BBB");
    expect((await phone.store.exportStateVector(shared)).byteLength).toBeGreaterThan(0);
    const left = new Y.Doc();
    Y.applyUpdate(left, await phone.store.exportUpdate(shared));
    expect(left.getText("body").toString()).toBe(merged);
  });

  it("prévient avant la purge, garde la session expirée et vide les caches", async () => {
    const names = new Set(["compte-textes"]);
    const previous = globalThis.caches;
    globalThis.caches = {
      keys: async () => [...names],
      delete: async (name: string) => names.delete(name),
    } as CacheStorage;
    try {
      const { store, databaseName } = await harness();
      const doc = await store.createDocument({ mode: "blank", pageFormat: "a4", title: "Privé" });
      await store.insertText(doc.id, 0, "brouillon");
      expect(await store.noteSessionExpired()).toEqual({ kept: 1 });
      expect(await store.listDocuments()).toHaveLength(1);
      const blocked = await store.inspectLogout();
      expect(blocked).toEqual({ unsynced: true, warning: LOGOUT_WARNING });
      await expect(store.purge()).rejects.toMatchObject({ code: "purge-blocked" });
      expect(await store.readText(doc.id)).toBe("brouillon");
      await store.purge({ acknowledgeLoss: true });
      expect(names.size).toBe(0);
      const namesAfter = (await indexedDB.databases()).map((item) => item.name);
      expect(namesAfter).not.toContain(doc.id);
      const fresh = await openLocalStore({ databaseName });
      opened.push(fresh);
      expect(await fresh.listDocuments()).toEqual([]);
      const synced = await fresh.createDocument({ mode: "document", pageFormat: "a4" });
      await fresh.flush(async () => undefined);
      expect(await fresh.inspectLogout()).toEqual({ unsynced: false, warning: null });
      await fresh.purge();
      expect(synced.id).not.toBe("");
    } finally {
      globalThis.caches = previous;
    }
  });

  it("refuse les secrets et n'émet ni titre ni requête d'analytique", async () => {
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: unknown) => {
      calls.push(String(input));
      return Promise.reject(new Error("fetch"));
    }) as typeof fetch;
    const payloads: unknown[] = [];
    const originalPost = BroadcastChannel.prototype.postMessage;
    BroadcastChannel.prototype.postMessage = function (this: BroadcastChannel, data: unknown) {
      payloads.push(structuredClone(data));
      return originalPost.call(this, data);
    };
    try {
      const { store } = await harness();
      const title = "Titre-particulier-T017";
      const doc = await store.createDocument({ mode: "novel", pageFormat: "a5", title });
      await store.insertText(doc.id, 0, "local");
      await store.setPreference("theme", "dark");
      expect(await store.getPreference("theme")).toBe("dark");
      await expect(store.setPreference("accessToken", "exemple")).rejects.toMatchObject({ code: "secret" });
      await expect(store.setPreference("theme", "Bearer exemple")).rejects.toMatchObject({ code: "secret" });
      expect(await store.getPreference("theme")).toBe("dark");
      const operations = await store.pendingOperations();
      expect(operations.length).toBeGreaterThan(0);
      expect(operations.every((operation) => !operation.path.includes(title))).toBe(true);
      expect(JSON.stringify(operations.map((operation) => operation.headers))).not.toContain(title);
      expect(JSON.stringify(payloads)).not.toContain(title);
      expect(calls).toEqual([]);
      for (const operation of operations) {
        expect(isSafeDocumentPath(operation.path)).toBe(true);
      }
    } finally {
      globalThis.fetch = originalFetch;
      BroadcastChannel.prototype.postMessage = originalPost;
    }
  });

  it("propage la liste et le texte entre onglets, puis la purge", async () => {
    const name = nextDatabaseName();
    const left = await openLocalStore({ databaseName: name });
    const right = await openLocalStore({ databaseName: name });
    opened.push(left, right);
    const changed = new Promise<StoreEvent>((resolve) => {
      right.subscribe((event) => {
        if (event.kind === "changed") {
          resolve(event);
        }
      });
    });
    const doc = await left.createDocument({ mode: "blank", pageFormat: "us_letter", title: "Onglet" });
    expect(await changed).toEqual({ kind: "changed", documentId: doc.id });
    expect(await right.listDocuments()).toEqual([expect.objectContaining({ id: doc.id, title: "Onglet" })]);
    await right.readText(doc.id);
    const edited = new Promise<void>((resolve) => {
      right.subscribe((event) => {
        if (event.kind === "changed") {
          resolve();
        }
      });
    });
    await left.insertText(doc.id, 0, "deux-onglets");
    await edited;
    expect(await right.readText(doc.id)).toBe("deux-onglets");
    const prefs = new Promise<void>((resolve) => {
      right.subscribe((event) => {
        if (event.kind === "preferences") {
          resolve();
        }
      });
    });
    await left.setPreference("density", "compact");
    await prefs;
    expect(await right.getPreference("density")).toBe("compact");
    await left.flush(async () => undefined);
    await right.flush(async () => undefined);
    const purged = new Promise<void>((resolve) => {
      right.subscribe((event) => {
        if (event.kind === "purged") {
          resolve();
        }
      });
    });
    await left.purge();
    await purged;
    await expect(right.listDocuments()).rejects.toMatchObject({ code: "closed" });
  });

  it("demande la persistance et, quota plein, garde la mémoire puis réessaie", async () => {
    let persists = 0;
    const gate = { fail: true };
    const sent: string[] = [];
    const events = new EventTarget();
    const timers = vi.spyOn(globalThis, "setTimeout");
    const name = nextDatabaseName();
    const store = await openLocalStore({
      databaseName: name,
      events,
      storage: {
        persist: async () => {
          persists += 1;
          return true;
        },
      },
      beforeWrite: () => {
        if (gate.fail) {
          throw quotaError();
        }
      },
      send: async (operation) => {
        sent.push(operation.path);
        expect(operation.direct).toBe(true);
      },
    });
    opened.push(store);
    expect(persists).toBe(1);
    expect(store.isPersistent()).toBe(true);
    const doc = await store.createDocument({ mode: "blank", pageFormat: "a4", title: "Mémoire" });
    await store.insertText(doc.id, 0, "encore là");
    expect(store.isMemoryOnly()).toBe(true);
    expect(await store.listDocuments()).toEqual([expect.objectContaining({ id: doc.id, title: "Mémoire" })]);
    expect(await store.readText(doc.id)).toBe("encore là");
    expect(sent.length).toBeGreaterThan(0);
    expect(timers.mock.calls.map((call) => call[1])).toContain(QUOTA_RETRY_MS);
    timers.mockRestore();
    gate.fail = false;
    events.dispatchEvent(new Event("pagehide"));
    await store.persist();
    expect(store.isMemoryOnly()).toBe(false);
    await store.close();
    const reopened = await openLocalStore({ databaseName: name });
    opened.push(reopened);
    expect(await reopened.readText(doc.id)).toBe("encore là");
    expect((await reopened.listDocuments())[0]?.title).toBe("Mémoire");
  });
});
