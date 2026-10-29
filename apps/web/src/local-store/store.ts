import { IndexeddbPersistence, clearDocument, fetchUpdates, storeState } from "y-indexeddb";
import * as Y from "yjs";

import { bytesToBase64, base64ToBytes, countWords } from "./coding.ts";
import { type CounterRow, type DocumentRow, LocalDatabase, type PreferenceRow } from "./db.ts";
import {
  DOCUMENTS_COLLECTION,
  assertDatabaseName,
  assertFont,
  assertFontSize,
  assertImportSource,
  assertIndex,
  assertMode,
  assertOperation,
  assertPageFormat,
  assertPreference,
  assertTitle,
  documentPath,
  isQuotaError,
} from "./guards.ts";
import {
  BODY_TEXT,
  DEFAULT_TITLE,
  LAST_DOCUMENT_PREFERENCE,
  LOGOUT_WARNING,
  PROSEMIRROR_FRAGMENT,
  QUOTA_RETRY_MS,
  SCHEMA_VERSION,
  type Confirmation,
  type CreateDocumentInput,
  type DocumentPatch,
  type FlushResult,
  type LocalDocument,
  type LocalStore,
  type LocalStoreOptions,
  type LogoutInspection,
  type ReopenedDocument,
  type RestOperation,
  type StoreEvent,
  LocalStoreError,
} from "./types.ts";
import { normalizeUuidV7, uuidV7 } from "./uuid.ts";

type Memory = {
  active: boolean;
  documents: Map<string, DocumentRow>;
  preferences: Map<string, string>;
  operations: Map<string, RestOperation>;
  counters: Map<string, CounterRow>;
};

type OpenDoc = {
  id: string;
  doc: Y.Doc;
  persistence: IndexeddbPersistence | null;
  localEdits: number;
  savedEdits: number;
};

type Batch = {
  documents?: DocumentRow[];
  operations?: RestOperation[];
  preferences?: PreferenceRow[];
  deleteDocumentIds?: string[];
  deleteOperationIds?: string[];
};

type ConfirmationAction = "trash" | "permanent";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function toDocument(row: DocumentRow): LocalDocument {
  return {
    id: row.id,
    title: row.title,
    mode: row.mode,
    pageFormat: row.pageFormat,
    fontFamily: row.fontFamily,
    baseFontSizePt: row.baseFontSizePt,
    wordCount: row.wordCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
    schemaVersion: row.schemaVersion,
  };
}

function toPublic(operation: RestOperation): RestOperation {
  return { ...operation, headers: { ...operation.headers } };
}

function byUpdatedDesc(left: DocumentRow, right: DocumentRow): number {
  if (left.updatedAt === right.updatedAt) {
    return left.id < right.id ? 1 : -1;
  }
  return left.updatedAt < right.updatedAt ? 1 : -1;
}

function operationHeaders(idempotencyKey: string, schema: boolean): Record<string, string> {
  const headers: Record<string, string> = { "idempotency-key": idempotencyKey };
  if (schema) {
    headers["x-flaw-schema-version"] = String(SCHEMA_VERSION);
  }
  return headers;
}

/** Texte brut du contenu : fragment ProseMirror s'il existe, sinon `body` (repli T-017). */
function documentText(doc: Y.Doc): string {
  const fragment = doc.getXmlFragment(PROSEMIRROR_FRAGMENT);
  if (fragment.length === 0) {
    return doc.getText(BODY_TEXT).toString();
  }
  const blocks: string[] = [];
  const walk = (node: Y.XmlElement | Y.XmlFragment, into: string[]): void => {
    for (const child of node.toArray()) {
      if (child instanceof Y.XmlText) {
        into.push(child.toString().replace(/<[^>]*>/gu, ""));
      } else if (child instanceof Y.XmlElement) {
        const inner: string[] = [];
        walk(child, inner);
        blocks.push(inner.join(""));
      }
    }
  };
  walk(fragment, blocks);
  return blocks.join("\n");
}

async function clearAccountCaches(): Promise<void> {
  const cachesApi = globalThis.caches;
  if (!cachesApi) {
    return;
  }
  const keys = await cachesApi.keys();
  await Promise.all(keys.map((key) => cachesApi.delete(key)));
}

async function requestPersistentStorage(storage: Pick<StorageManager, "persist"> | undefined): Promise<boolean> {
  const target = storage ?? globalThis.navigator?.storage;
  if (!target?.persist) {
    return false;
  }
  try {
    return await target.persist();
  } catch {
    return false;
  }
}

export async function openLocalStore(options: LocalStoreOptions = {}): Promise<LocalStore> {
  const databaseName = options.databaseName ?? "flaw-local";
  assertDatabaseName(databaseName);
  const now = options.now ?? (() => new Date());
  const db = new LocalDatabase(databaseName);
  await db.open();
  const persistent = await requestPersistentStorage(options.storage);
  const memory: Memory = {
    active: false,
    documents: new Map(),
    preferences: new Map(),
    operations: new Map(),
    counters: new Map(),
  };
  const docs = new Map<string, OpenDoc>();
  const listeners = new Set<(event: StoreEvent) => void>();
  const confirmations = new Map<string, { documentId: string; action: ConfirmationAction }>();
  let closed = false;
  let lastStamp = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let tail: Promise<void> = Promise.resolve();
  let closePromise: Promise<void> | null = null;

  const channel = typeof globalThis.BroadcastChannel === "function" ? new BroadcastChannel(`flaw-local:${databaseName}`) : null;

  function assertOpen(): void {
    if (closed) {
      throw new LocalStoreError("closed", "Le stockage local est fermé.");
    }
  }

  function stamp(): string {
    const millis = Math.max(now().getTime(), lastStamp + 1);
    lastStamp = millis;
    return new Date(millis).toISOString();
  }

  function track<T>(work: () => Promise<T>): Promise<T> {
    const run = tail.then(work, work);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function publish(event: StoreEvent): void {
    const safe: StoreEvent =
      event.kind === "changed"
        ? { kind: "changed", documentId: normalizeUuidV7(event.documentId) }
        : event.kind === "preferences"
          ? { kind: "preferences" }
          : { kind: "purged" };
    for (const listener of listeners) {
      listener(safe);
    }
    channel?.postMessage(safe);
  }

  function armQuotaRetry(): void {
    if (timer !== undefined || closed) {
      return;
    }
    const handle = globalThis.setTimeout(() => {
      timer = undefined;
      void track(retryPersistentWrite);
    }, QUOTA_RETRY_MS);
    timer = handle;
  }

  function disarmQuotaRetry(): void {
    if (timer !== undefined) {
      globalThis.clearTimeout(timer);
      timer = undefined;
    }
  }

  async function activateMemory(): Promise<void> {
    if (memory.active) {
      return;
    }
    try {
      const [documents, operations, preferences, counters] = await Promise.all([
        db.documents.toArray(),
        db.operations.toArray(),
        db.preferences.toArray(),
        db.counters.toArray(),
      ]);
      memory.documents = new Map(documents.map((row) => [row.id, clone(row)]));
      memory.operations = new Map(operations.map((row) => [row.id, clone(row)]));
      memory.preferences = new Map(preferences.map((row) => [row.key, row.value]));
      memory.counters = new Map(counters.map((row) => [row.id, clone(row)]));
    } catch (error) {
      if (!isQuotaError(error)) {
        throw error;
      }
      memory.documents = new Map();
      memory.operations = new Map();
      memory.preferences = new Map();
      memory.counters = new Map();
    }
    memory.active = true;
  }

  async function commit(batch: Batch): Promise<void> {
    const applyMemory = (): void => {
      for (const id of batch.deleteOperationIds ?? []) {
        memory.operations.delete(id);
      }
      for (const id of batch.deleteDocumentIds ?? []) {
        memory.documents.delete(id);
        memory.counters.delete(id);
      }
      for (const row of batch.documents ?? []) {
        memory.documents.set(row.id, clone(row));
        memory.counters.set(row.id, { id: row.id, wordCount: row.wordCount });
      }
      for (const operation of batch.operations ?? []) {
        memory.operations.set(operation.id, clone(operation));
      }
      for (const preference of batch.preferences ?? []) {
        memory.preferences.set(preference.key, preference.value);
      }
    };

    if (!memory.active) {
      try {
        options.beforeWrite?.();
        await db.transaction("rw", db.documents, db.operations, db.preferences, db.counters, async () => {
          for (const id of batch.deleteOperationIds ?? []) {
            await db.operations.delete(id);
          }
          for (const id of batch.deleteDocumentIds ?? []) {
            await db.documents.delete(id);
            await db.counters.delete(id);
          }
          if (batch.documents && batch.documents.length > 0) {
            await db.documents.bulkPut(batch.documents);
          }
          if (batch.operations && batch.operations.length > 0) {
            await db.operations.bulkPut(batch.operations);
          }
          if (batch.preferences && batch.preferences.length > 0) {
            await db.preferences.bulkPut(batch.preferences);
          }
          for (const row of batch.documents ?? []) {
            await db.counters.put({ id: row.id, wordCount: row.wordCount });
          }
        });
        return;
      } catch (error) {
        if (!isQuotaError(error)) {
          throw error;
        }
        await activateMemory();
      }
    }
    applyMemory();
    armQuotaRetry();
  }

  async function directSend(operationId: string): Promise<void> {
    if (!options.send || !memory.active) {
      return;
    }
    const current = memory.operations.get(operationId);
    if (!current || current.status !== "pending") {
      return;
    }
    const marked: RestOperation = { ...current, direct: true };
    memory.operations.set(operationId, marked);
    try {
      await options.send(toPublic(marked));
    } catch {
      return;
    }
    const done: RestOperation = { ...marked, status: "done" };
    memory.operations.set(operationId, done);
    await relaxContent(done);
  }

  async function commitAndDirect(batch: Batch): Promise<void> {
    for (const operation of batch.operations ?? []) {
      assertOperation(operation);
    }
    await commit(batch);
    if (!memory.active) {
      return;
    }
    for (const operation of batch.operations ?? []) {
      if (operation.status === "pending") {
        await directSend(operation.id);
      }
    }
  }

  async function getRow(id: string): Promise<DocumentRow | null> {
    if (memory.active) {
      const row = memory.documents.get(id);
      return row ? clone(row) : null;
    }
    const row = await db.documents.get(id);
    return row ? clone(row) : null;
  }

  async function allRows(): Promise<DocumentRow[]> {
    if (memory.active) {
      return [...memory.documents.values()].map((row) => clone(row));
    }
    const rows = await db.documents.toArray();
    return rows.map((row) => clone(row));
  }

  async function allOperations(): Promise<RestOperation[]> {
    if (memory.active) {
      return [...memory.operations.values()].map((row) => clone(row));
    }
    const rows = await db.operations.toArray();
    return rows.map((row) => clone(row));
  }

  async function getPreferenceValue(key: string): Promise<string | null> {
    if (memory.active) {
      return memory.preferences.get(key) ?? null;
    }
    const row = await db.preferences.get(key);
    return row?.value ?? null;
  }

  async function mustRow(id: string): Promise<DocumentRow> {
    const row = await getRow(normalizeUuidV7(id));
    if (!row) {
      throw new LocalStoreError("missing", "Texte introuvable.");
    }
    return row;
  }

  async function mustActive(id: string): Promise<DocumentRow> {
    const row = await mustRow(id);
    if (row.deletedAt !== null) {
      throw new LocalStoreError("missing", "Texte introuvable.");
    }
    return row;
  }

  function makeOperation(
    documentId: string,
    method: RestOperation["method"],
    path: string,
    body: string | null,
    schema: boolean,
  ): RestOperation {
    const idempotencyKey = uuidV7(now().getTime());
    const operation: RestOperation = {
      id: uuidV7(now().getTime()),
      documentId,
      idempotencyKey,
      method,
      path,
      body,
      headers: operationHeaders(idempotencyKey, schema),
      status: "pending",
      createdAt: stamp(),
      attempts: 0,
      direct: false,
    };
    assertOperation(operation);
    return operation;
  }

  async function relaxContent(operation: RestOperation): Promise<void> {
    if (!operation.path.endsWith("/sync")) {
      return;
    }
    const left = (await allOperations()).some(
      (item) => item.documentId === operation.documentId && item.path.endsWith("/sync") && item.status !== "done",
    );
    if (left) {
      return;
    }
    const row = await getRow(operation.documentId);
    if (!row?.contentPending) {
      return;
    }
    await commit({ documents: [{ ...row, contentPending: false }] });
  }

  async function ensurePersistence(entry: OpenDoc): Promise<void> {
    if (entry.persistence) {
      return;
    }
    options.beforeWrite?.();
    const persistence = new IndexeddbPersistence(entry.id, entry.doc);
    entry.persistence = persistence;
    try {
      await persistence._db;
      if (!persistence.synced) {
        await persistence.whenSynced;
      }
    } catch (error) {
      entry.persistence = null;
      await persistence.destroy().catch(() => undefined);
      throw error;
    }
  }

  async function persistY(entry: OpenDoc): Promise<void> {
    if (!entry.persistence) {
      armQuotaRetry();
      return;
    }
    try {
      options.beforeWrite?.();
      await storeState(entry.persistence, true);
    } catch (error) {
      if (!isQuotaError(error)) {
        throw error;
      }
      const persistence = entry.persistence;
      entry.persistence = null;
      await persistence.destroy().catch(() => undefined);
      armQuotaRetry();
    }
  }

  function openEntry(id: string): OpenDoc {
    const existing = docs.get(id);
    if (existing) {
      return existing;
    }
    const doc = new Y.Doc();
    const entry: OpenDoc = { id, doc, persistence: null, localEdits: 0, savedEdits: 0 };
    doc.on("update", (_update, origin) => {
      if (entry.persistence && origin === entry.persistence) {
        return;
      }
      entry.localEdits += 1;
    });
    docs.set(id, entry);
    return entry;
  }

  async function openY(id: string): Promise<OpenDoc> {
    const entry = openEntry(id);
    try {
      await ensurePersistence(entry);
    } catch (error) {
      if (!isQuotaError(error)) {
        throw error;
      }
      armQuotaRetry();
    }
    entry.doc.getXmlFragment(PROSEMIRROR_FRAGMENT);
    entry.doc.getText(BODY_TEXT);
    return entry;
  }

  async function destroyY(id: string): Promise<void> {
    const entry = docs.get(id);
    if (entry?.persistence) {
      await entry.persistence.clearData().catch(async () => {
        await clearDocument(id).catch(() => undefined);
      });
    } else {
      await clearDocument(id).catch(() => undefined);
    }
    docs.delete(id);
  }

  async function writeContentSnapshot(id: string, text: string, update: Uint8Array, vector: Uint8Array): Promise<void> {
    const row = await getRow(id);
    if (!row || row.deletedAt !== null) {
      return;
    }
    const body = JSON.stringify({
      stateVector: bytesToBase64(vector),
      update: bytesToBase64(update),
    });
    const existing = (await allOperations()).find(
      (operation) => operation.documentId === id && operation.status === "pending" && operation.path.endsWith("/sync"),
    );
    const sync = existing
      ? { ...existing, body }
      : makeOperation(id, "POST", documentPath(id, "sync"), body, true);
    const next: DocumentRow = {
      ...row,
      wordCount: countWords(text),
      updatedAt: stamp(),
      contentPending: true,
    };
    await commitAndDirect({ documents: [next], operations: [sync] });
    if (!memory.active) {
      publish({ kind: "changed", documentId: id });
    }
  }

  async function captureIfEdited(id: string): Promise<void> {
    const entry = docs.get(id);
    if (!entry || entry.localEdits === entry.savedEdits) {
      return;
    }
    const seen = entry.localEdits;
    const text = documentText(entry.doc);
    const update = Y.encodeStateAsUpdate(entry.doc);
    const vector = Y.encodeStateVector(entry.doc);
    await writeContentSnapshot(id, text, update, vector);
    if (entry.localEdits === seen) {
      entry.savedEdits = seen;
    }
  }

  async function rememberLast(id: string): Promise<void> {
    assertPreference(LAST_DOCUMENT_PREFERENCE, id);
    await commit({ preferences: [{ key: LAST_DOCUMENT_PREFERENCE, value: id }] });
    if (!memory.active) {
      publish({ kind: "preferences" });
    }
  }

  async function flushMemory(): Promise<void> {
    if (!memory.active) {
      return;
    }
    const documents = [...memory.documents.values()];
    const operations = [...memory.operations.values()];
    const preferences = [...memory.preferences.entries()].map(([key, value]) => ({ key, value }));
    const counters = [...memory.counters.values()];
    options.beforeWrite?.();
    await db.transaction("rw", db.documents, db.operations, db.preferences, db.counters, async () => {
      await db.documents.clear();
      await db.operations.clear();
      await db.preferences.clear();
      await db.counters.clear();
      if (documents.length > 0) {
        await db.documents.bulkPut(documents);
      }
      if (operations.length > 0) {
        await db.operations.bulkPut(operations);
      }
      if (preferences.length > 0) {
        await db.preferences.bulkPut(preferences);
      }
      if (counters.length > 0) {
        await db.counters.bulkPut(counters);
      }
    });
    const ids = documents.map((row) => row.id);
    memory.active = false;
    memory.documents.clear();
    memory.operations.clear();
    memory.preferences.clear();
    memory.counters.clear();
    for (const id of ids) {
      publish({ kind: "changed", documentId: id });
    }
  }

  async function retryPersistentWrite(): Promise<void> {
    if (closed) {
      return;
    }
    for (const id of [...docs.keys()]) {
      await captureIfEdited(id);
    }
    try {
      await flushMemory();
    } catch (error) {
      if (!isQuotaError(error)) {
        throw error;
      }
      armQuotaRetry();
      return;
    }
    for (const entry of docs.values()) {
      try {
        await ensurePersistence(entry);
        await persistY(entry);
      } catch (error) {
        if (!isQuotaError(error)) {
          throw error;
        }
        armQuotaRetry();
      }
    }
    const durable = !memory.active && [...docs.values()].every((entry) => entry.persistence !== null);
    if (durable) {
      disarmQuotaRetry();
    }
  }

  async function release(deleteDatabase: boolean): Promise<void> {
    closed = true;
    disarmQuotaRetry();
    events?.removeEventListener("pagehide", onHide);
    events?.removeEventListener("beforeunload", onHide);
    for (const entry of docs.values()) {
      if (entry.persistence) {
        await entry.persistence.destroy().catch(() => undefined);
      }
    }
    docs.clear();
    listeners.clear();
    confirmations.clear();
    memory.active = false;
    memory.documents.clear();
    memory.operations.clear();
    memory.preferences.clear();
    memory.counters.clear();
    channel?.close();
    if (deleteDatabase) {
      await clearAccountCaches();
      db.close();
      await db.delete().catch(() => undefined);
      return;
    }
    db.close();
  }

  async function purgeInternal(remote: boolean, acknowledgeLoss: boolean): Promise<void> {
    assertOpen();
    if (!remote) {
      if ((await hasUnsynced()) && !acknowledgeLoss) {
        throw new LocalStoreError("purge-blocked", LOGOUT_WARNING);
      }
    }
    const ids = (await allRows()).map((row) => row.id);
    for (const id of ids) {
      await destroyY(id);
    }
    if (!remote) {
      publish({ kind: "purged" });
    }
    await release(true);
  }

  const events = options.events ?? (globalThis.window ?? null);
  const onHide = (): void => {
    void track(retryPersistentWrite);
  };
  events?.addEventListener("pagehide", onHide);
  events?.addEventListener("beforeunload", onHide);

  channel?.addEventListener("message", (message: MessageEvent<unknown>) => {
    void track(async () => {
      if (closed) {
        return;
      }
      const event = parseEvent(message.data);
      if (!event) {
        return;
      }
      if (event.kind === "purged") {
        for (const listener of [...listeners]) {
          listener(event);
        }
        await purgeInternal(true, true).catch(() => undefined);
        return;
      }
      if (event.kind === "changed") {
        const entry = docs.get(event.documentId);
        if (entry?.persistence) {
          await fetchUpdates(entry.persistence).catch(() => undefined);
        }
      }
      for (const listener of listeners) {
        listener(event);
      }
    });
  });

  async function hasUnsynced(): Promise<boolean> {
    assertOpen();
    const operations = await allOperations();
    if (operations.some((operation) => operation.status !== "done")) {
      return true;
    }
    const rows = await allRows();
    return rows.some((row) => row.contentPending);
  }

  async function createDocument(input: CreateDocumentInput): Promise<LocalDocument> {
    assertOpen();
    assertMode(input.mode);
    assertPageFormat(input.pageFormat);
    const id = input.id === undefined ? uuidV7(now().getTime()) : normalizeUuidV7(input.id);
    if (await getRow(id)) {
      throw new LocalStoreError("exists", "Ce texte existe déjà.");
    }
    const title = input.title === undefined ? DEFAULT_TITLE : input.title;
    assertTitle(title);
    let fontFamily: string | null = null;
    if (input.fontFamily !== undefined) {
      assertFont(input.fontFamily);
      fontFamily = input.fontFamily;
    }
    let baseFontSizePt: number | null = null;
    if (input.baseFontSizePt !== undefined) {
      assertFontSize(input.baseFontSizePt);
      baseFontSizePt = input.baseFontSizePt;
    }
    if (input.importedFrom !== undefined) {
      assertImportSource(input.importedFrom);
    }
    const createdAt = stamp();
    const row: DocumentRow = {
      id,
      title,
      mode: input.mode,
      pageFormat: input.pageFormat,
      fontFamily,
      baseFontSizePt,
      wordCount: 0,
      createdAt,
      updatedAt: createdAt,
      deletedAt: null,
      cursor: null,
      contentPending: true,
      schemaVersion: SCHEMA_VERSION,
    };
    const body: Record<string, string | number> = {
      id,
      mode: input.mode,
      title,
      pageFormat: input.pageFormat,
    };
    if (fontFamily !== null) {
      body.fontFamily = fontFamily;
    }
    if (baseFontSizePt !== null) {
      body.baseFontSizePt = baseFontSizePt;
    }
    if (input.importedFrom !== undefined) {
      body.importedFrom = input.importedFrom;
    }
    const operation = makeOperation(id, "POST", DOCUMENTS_COLLECTION, JSON.stringify(body), false);
    await commitAndDirect({ documents: [row], operations: [operation] });
    const entry = await openY(id);
    await persistY(entry);
    const seen = entry.localEdits;
    await writeContentSnapshot(
      id,
      entry.doc.getText(BODY_TEXT).toString(),
      Y.encodeStateAsUpdate(entry.doc),
      Y.encodeStateVector(entry.doc),
    );
    if (entry.localEdits === seen) {
      entry.savedEdits = seen;
    }
    await rememberLast(id);
    if (!memory.active) {
      publish({ kind: "changed", documentId: id });
    }
    return toDocument((await getRow(id)) ?? row);
  }

  async function listDocuments(): Promise<LocalDocument[]> {
    assertOpen();
    return (await allRows()).filter((row) => row.deletedAt === null).sort(byUpdatedDesc).map(toDocument);
  }

  async function listTrash(): Promise<LocalDocument[]> {
    assertOpen();
    return (await allRows())
      .filter((row) => row.deletedAt !== null)
      .sort((left, right) => {
        const leftDeleted = left.deletedAt ?? "";
        const rightDeleted = right.deletedAt ?? "";
        if (leftDeleted === rightDeleted) {
          return left.id < right.id ? 1 : -1;
        }
        return leftDeleted < rightDeleted ? 1 : -1;
      })
      .map(toDocument);
  }

  async function updateDocument(id: string, patch: DocumentPatch): Promise<LocalDocument> {
    assertOpen();
    const keys = Object.keys(patch);
    if (keys.length === 0) {
      throw new LocalStoreError("invalid", "Modification vide.");
    }
    const row = await mustActive(id);
    const next: DocumentRow = { ...row, updatedAt: stamp() };
    const body: Record<string, string | number> = {};
    if (patch.title !== undefined) {
      assertTitle(patch.title);
      next.title = patch.title;
      body.title = patch.title;
    }
    if (patch.pageFormat !== undefined) {
      assertPageFormat(patch.pageFormat);
      next.pageFormat = patch.pageFormat;
      body.pageFormat = patch.pageFormat;
    }
    if (patch.fontFamily !== undefined) {
      assertFont(patch.fontFamily);
      next.fontFamily = patch.fontFamily;
      body.fontFamily = patch.fontFamily;
    }
    if (patch.baseFontSizePt !== undefined) {
      assertFontSize(patch.baseFontSizePt);
      next.baseFontSizePt = patch.baseFontSizePt;
      body.baseFontSizePt = patch.baseFontSizePt;
    }
    const operation = makeOperation(next.id, "PATCH", documentPath(next.id), JSON.stringify(body), false);
    await commitAndDirect({ documents: [next], operations: [operation] });
    if (!memory.active) {
      publish({ kind: "changed", documentId: next.id });
    }
    return toDocument(next);
  }

  async function requestConfirmation(id: string, action: ConfirmationAction): Promise<Confirmation> {
    assertOpen();
    const row = await mustRow(id);
    if (action === "trash" && row.deletedAt !== null) {
      throw new LocalStoreError("missing", "Texte introuvable.");
    }
    if (action === "permanent" && row.deletedAt === null) {
      throw new LocalStoreError("invalid", "La suppression définitive part de la corbeille.");
    }
    const confirmationId = uuidV7(now().getTime());
    confirmations.set(confirmationId, { documentId: row.id, action });
    return { confirmationRequired: true, defaultFocus: "cancel", documentId: row.id, confirmationId };
  }

  function consumeConfirmation(id: string, confirmationId: string, action: ConfirmationAction): void {
    const found = confirmations.get(confirmationId);
    confirmations.delete(confirmationId);
    if (!found || found.documentId !== id || found.action !== action) {
      throw new LocalStoreError("confirmation", "Confirmation absente. Le focus par défaut reste Annuler.");
    }
  }

  async function confirmTrash(id: string, confirmationId: string): Promise<LocalDocument> {
    assertOpen();
    const row = await mustActive(id);
    consumeConfirmation(row.id, confirmationId, "trash");
    const deletedAt = stamp();
    const next: DocumentRow = { ...row, deletedAt, updatedAt: deletedAt };
    const operation = makeOperation(row.id, "DELETE", documentPath(row.id), null, false);
    await commitAndDirect({ documents: [next], operations: [operation] });
    if (!memory.active) {
      publish({ kind: "changed", documentId: row.id });
    }
    return toDocument(next);
  }

  async function confirmPermanentDelete(id: string, confirmationId: string): Promise<void> {
    assertOpen();
    const row = await mustRow(id);
    if (row.deletedAt === null) {
      throw new LocalStoreError("invalid", "La suppression définitive part de la corbeille.");
    }
    consumeConfirmation(row.id, confirmationId, "permanent");
    const operation = makeOperation(row.id, "DELETE", documentPath(row.id, "permanent"), null, false);
    await commitAndDirect({ deleteDocumentIds: [row.id], operations: [operation] });
    await destroyY(row.id);
    if (!memory.active) {
      publish({ kind: "changed", documentId: row.id });
    }
  }

  async function restoreDocument(id: string): Promise<LocalDocument> {
    assertOpen();
    const row = await mustRow(id);
    if (row.deletedAt === null) {
      throw new LocalStoreError("missing", "Texte introuvable dans la corbeille.");
    }
    const next: DocumentRow = { ...row, deletedAt: null, updatedAt: stamp() };
    const operation = makeOperation(row.id, "POST", documentPath(row.id, "restore"), "{}", false);
    await commitAndDirect({ documents: [next], operations: [operation] });
    if (!memory.active) {
      publish({ kind: "changed", documentId: row.id });
    }
    return toDocument(next);
  }

  async function openDocument(id: string): Promise<Y.Doc> {
    assertOpen();
    const row = await mustActive(id);
    const entry = await openY(row.id);
    await captureIfEdited(row.id);
    await rememberLast(row.id);
    return entry.doc;
  }

  async function readText(id: string): Promise<string> {
    assertOpen();
    const row = await mustRow(id);
    const entry = await openY(row.id);
    return entry.doc.getText(BODY_TEXT).toString();
  }

  async function insertText(id: string, index: number, text: string): Promise<void> {
    assertOpen();
    const row = await mustActive(id);
    const entry = await openY(row.id);
    const ytext = entry.doc.getText(BODY_TEXT);
    assertIndex(index, ytext.length);
    if (text.length > 0) {
      ytext.insert(index, text);
    }
    await persistY(entry);
    await captureIfEdited(row.id);
    await rememberLast(row.id);
  }

  async function deleteText(id: string, index: number, length: number): Promise<void> {
    assertOpen();
    if (!Number.isInteger(length) || length < 0) {
      throw new LocalStoreError("invalid", "Longueur invalide.");
    }
    const row = await mustActive(id);
    const entry = await openY(row.id);
    const ytext = entry.doc.getText(BODY_TEXT);
    assertIndex(index, ytext.length);
    if (index + length > ytext.length) {
      throw new LocalStoreError("invalid", "Longueur invalide.");
    }
    if (length > 0) {
      ytext.delete(index, length);
    }
    await persistY(entry);
    await captureIfEdited(row.id);
    await rememberLast(row.id);
  }

  async function setCursor(id: string, index: number): Promise<void> {
    assertOpen();
    const row = await mustActive(id);
    const entry = await openY(row.id);
    const ytext = entry.doc.getText(BODY_TEXT);
    assertIndex(index, ytext.length);
    const relative = Y.createRelativePositionFromTypeIndex(ytext, index);
    const cursor = bytesToBase64(Y.encodeRelativePosition(relative));
    await commit({ documents: [{ ...row, cursor }] });
    await rememberLast(row.id);
  }

  /** Position relative Yjs encodée (éditeur ProseMirror), rangée telle quelle. */
  async function saveCursor(id: string, cursor: Uint8Array): Promise<void> {
    assertOpen();
    const row = await mustActive(id);
    await commit({ documents: [{ ...row, cursor: bytesToBase64(cursor) }] });
  }

  async function loadCursor(id: string): Promise<Uint8Array | null> {
    assertOpen();
    const row = await mustRow(id);
    return row.cursor === null ? null : base64ToBytes(row.cursor);
  }

  async function cursorIndex(id: string): Promise<number | null> {
    assertOpen();
    const row = await mustRow(id);
    if (row.cursor === null) {
      return null;
    }
    const entry = await openY(row.id);
    try {
      const absolute = Y.createAbsolutePositionFromRelativePosition(
        Y.decodeRelativePosition(base64ToBytes(row.cursor)),
        entry.doc,
      );
      return absolute ? absolute.index : null;
    } catch {
      return null;
    }
  }

  async function reopenLast(): Promise<ReopenedDocument | null> {
    assertOpen();
    const id = await getPreferenceValue(LAST_DOCUMENT_PREFERENCE);
    if (!id) {
      return null;
    }
    const row = await getRow(id);
    if (!row || row.deletedAt !== null) {
      return null;
    }
    return { id: row.id, index: await cursorIndex(row.id) };
  }

  async function flush(send: (operation: RestOperation) => Promise<void>): Promise<FlushResult> {
    assertOpen();
    const queue = (await allOperations())
      .filter((operation) => operation.status !== "done")
      .sort((left, right) => (left.createdAt < right.createdAt ? -1 : 1));
    let sent = 0;
    for (const operation of queue) {
      const inflight: RestOperation = { ...operation, status: "inflight", attempts: operation.attempts + 1 };
      await commit({ operations: [inflight] });
      try {
        await send(toPublic(inflight));
      } catch {
        await commit({ operations: [{ ...inflight, status: "pending" }] });
        return { sent, stopped: true };
      }
      const done: RestOperation = { ...inflight, status: "done" };
      await commit({ operations: [done] });
      await relaxContent(done);
      sent += 1;
    }
    return { sent, stopped: false };
  }

  async function exportUpdate(id: string): Promise<Uint8Array> {
    assertOpen();
    const row = await mustRow(id);
    const entry = await openY(row.id);
    return Y.encodeStateAsUpdate(entry.doc);
  }

  async function exportStateVector(id: string): Promise<Uint8Array> {
    assertOpen();
    const row = await mustRow(id);
    const entry = await openY(row.id);
    return Y.encodeStateVector(entry.doc);
  }

  async function importUpdate(id: string, update: Uint8Array): Promise<void> {
    assertOpen();
    const row = await mustActive(id);
    const entry = await openY(row.id);
    Y.applyUpdate(entry.doc, update, "remote-import");
    await persistY(entry);
    await captureIfEdited(row.id);
  }

  function isMemoryOnly(): boolean {
    if (memory.active) {
      return true;
    }
    for (const entry of docs.values()) {
      if (entry.persistence === null) {
        return true;
      }
    }
    return false;
  }

  async function close(): Promise<void> {
    if (closePromise) {
      await closePromise;
      return;
    }
    closePromise = track(async () => {
      try {
        await retryPersistentWrite();
      } catch {
        // La fermeture vide quand même les connexions ouvertes.
      }
      await release(false);
    });
    await closePromise;
  }

  return {
    isPersistent: () => persistent,
    isMemoryOnly,
    createDocument,
    listDocuments,
    listTrash,
    updateDocument,
    renameDocument: (id, title) => updateDocument(id, { title }),
    requestTrash: (id) => requestConfirmation(id, "trash"),
    confirmTrash,
    requestPermanentDelete: (id) => requestConfirmation(id, "permanent"),
    confirmPermanentDelete,
    restoreDocument,
    openDocument,
    readText,
    insertText,
    deleteText,
    setCursor,
    cursorIndex,
    reopenLast,
    getPreference: async (key) => {
      assertOpen();
      assertPreference(key, "");
      return getPreferenceValue(key);
    },
    setPreference: async (key, value) => {
      assertOpen();
      assertPreference(key, value);
      await commit({ preferences: [{ key, value }] });
      if (!memory.active) {
        publish({ kind: "preferences" });
      }
    },
    pendingOperations: async () => {
      assertOpen();
      return (await allOperations())
        .filter((operation) => operation.status !== "done")
        .sort((left, right) => (left.createdAt < right.createdAt ? -1 : 1))
        .map(toPublic);
    },
    flush,
    hasUnsynced,
    inspectLogout: async (): Promise<LogoutInspection> => {
      assertOpen();
      const unsynced = await hasUnsynced();
      return { unsynced, warning: unsynced ? LOGOUT_WARNING : null };
    },
    noteSessionExpired: async () => {
      assertOpen();
      const rows = await allRows();
      return { kept: rows.length };
    },
    purge: (purgeOptions) => purgeInternal(false, purgeOptions?.acknowledgeLoss === true),
    exportUpdate,
    exportStateVector,
    importUpdate,
    persist: () => track(retryPersistentWrite),
    saveCursor: (id: string, cursor: Uint8Array) => track(() => saveCursor(normalizeUuidV7(id), cursor)),
    loadCursor: (id: string) => loadCursor(normalizeUuidV7(id)),
    captureEdits: (id: string) => {
      assertOpen();
      return track(() => captureIfEdited(normalizeUuidV7(id)));
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close,
  };
}

function parseEvent(data: unknown): StoreEvent | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const kind = (data as { kind?: unknown }).kind;
  if (kind === "purged") {
    return { kind: "purged" };
  }
  if (kind === "preferences") {
    return { kind: "preferences" };
  }
  if (kind !== "changed") {
    return null;
  }
  const documentId = (data as { documentId?: unknown }).documentId;
  if (typeof documentId !== "string") {
    return null;
  }
  try {
    return { kind: "changed", documentId: normalizeUuidV7(documentId) };
  } catch {
    return null;
  }
}
