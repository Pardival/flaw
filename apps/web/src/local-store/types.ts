import type { Doc } from "yjs";

/**
 * Stockage local (T-017). Les modes et formats sont ceux de main
 * (`novel`, `screenplay`, `document`, `blank`), pas les libellés français du cahier.
 */

export const DOCUMENT_MODES = ["novel", "screenplay", "document", "blank"] as const;

export type DocumentMode = (typeof DOCUMENT_MODES)[number];

export const PAGE_FORMATS = ["novel_13x20", "pocket_11x17_8", "trade_15x23", "a5", "a4", "us_letter"] as const;

export type PageFormat = (typeof PAGE_FORMATS)[number];

export const IMPORT_SOURCES = ["docx", "txt", "md"] as const;

export type ImportSource = (typeof IMPORT_SOURCES)[number];

/** Aligné sur `SCHEMA_VERSION` de @flaw/schema, sans importer le baril ProseMirror. */
export const SCHEMA_VERSION = 1;

export const DEFAULT_TITLE = "Sans titre";

export const QUOTA_RETRY_MS = 60_000;

export const LOGOUT_WARNING =
  "Des modifications locales ne sont pas synchronisées. Synchronisez-les, ou confirmez explicitement la perte avant la déconnexion.";

/** Fragment ProseMirror du Y.Doc (A-008, `content`), lu par l'éditeur et par le serveur. */
export const PROSEMIRROR_FRAGMENT = "content";

export const BODY_TEXT = "body";

export const LAST_DOCUMENT_PREFERENCE = "lastDocumentId";

export type LocalDocument = {
  id: string;
  title: string;
  mode: DocumentMode;
  pageFormat: PageFormat;
  fontFamily: string | null;
  baseFontSizePt: number | null;
  wordCount: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  schemaVersion: number;
};

export type CreateDocumentInput = {
  id?: string;
  mode: DocumentMode;
  pageFormat: PageFormat;
  title?: string;
  fontFamily?: string;
  baseFontSizePt?: number;
  importedFrom?: ImportSource;
};

export type DocumentPatch = {
  title?: string;
  pageFormat?: PageFormat;
  fontFamily?: string;
  baseFontSizePt?: number;
};

export type RestOperation = {
  id: string;
  documentId: string;
  idempotencyKey: string;
  method: "POST" | "PATCH" | "DELETE";
  path: string;
  body: string | null;
  headers: Record<string, string>;
  status: "pending" | "inflight" | "done";
  createdAt: string;
  attempts: number;
  direct: boolean;
};

export type Confirmation = {
  confirmationRequired: true;
  defaultFocus: "cancel";
  documentId: string;
  confirmationId: string;
};

export type StoreEvent =
  | { kind: "changed"; documentId: string }
  | { kind: "preferences" }
  | { kind: "purged" };

export type LogoutInspection = {
  unsynced: boolean;
  warning: string | null;
};

export type ReopenedDocument = {
  id: string;
  index: number | null;
};

export type FlushResult = {
  sent: number;
  stopped: boolean;
};

export type LocalStoreErrorCode =
  | "invalid"
  | "missing"
  | "exists"
  | "secret"
  | "confirmation"
  | "purge-blocked"
  | "closed";

export class LocalStoreError extends Error {
  readonly code: LocalStoreErrorCode;

  constructor(code: LocalStoreErrorCode, message: string) {
    super(message);
    this.name = "LocalStoreError";
    this.code = code;
  }
}

export type LocalStoreOptions = {
  databaseName?: string;
  now?: () => Date;
  storage?: Pick<StorageManager, "persist">;
  events?: EventTarget;
  beforeWrite?: () => void;
  send?: (operation: RestOperation) => Promise<void>;
};

export type LocalStore = {
  isPersistent: () => boolean;
  isMemoryOnly: () => boolean;
  createDocument: (input: CreateDocumentInput) => Promise<LocalDocument>;
  listDocuments: () => Promise<LocalDocument[]>;
  listTrash: () => Promise<LocalDocument[]>;
  updateDocument: (id: string, patch: DocumentPatch) => Promise<LocalDocument>;
  renameDocument: (id: string, title: string) => Promise<LocalDocument>;
  requestTrash: (id: string) => Promise<Confirmation>;
  confirmTrash: (id: string, confirmationId: string) => Promise<LocalDocument>;
  requestPermanentDelete: (id: string) => Promise<Confirmation>;
  confirmPermanentDelete: (id: string, confirmationId: string) => Promise<void>;
  restoreDocument: (id: string) => Promise<LocalDocument>;
  openDocument: (id: string) => Promise<Doc>;
  readText: (id: string) => Promise<string>;
  insertText: (id: string, index: number, text: string) => Promise<void>;
  deleteText: (id: string, index: number, length: number) => Promise<void>;
  setCursor: (id: string, index: number) => Promise<void>;
  cursorIndex: (id: string) => Promise<number | null>;
  reopenLast: () => Promise<ReopenedDocument | null>;
  getPreference: (key: string) => Promise<string | null>;
  setPreference: (key: string, value: string) => Promise<void>;
  pendingOperations: () => Promise<RestOperation[]>;
  flush: (send: (operation: RestOperation) => Promise<void>) => Promise<FlushResult>;
  hasUnsynced: () => Promise<boolean>;
  inspectLogout: () => Promise<LogoutInspection>;
  noteSessionExpired: () => Promise<{ kept: number }>;
  purge: (options?: { acknowledgeLoss?: boolean }) => Promise<void>;
  exportUpdate: (id: string) => Promise<Uint8Array>;
  exportStateVector: (id: string) => Promise<Uint8Array>;
  importUpdate: (id: string, update: Uint8Array) => Promise<void>;
  persist: () => Promise<void>;
  /** Enregistre les modifications du Y.Doc ouvert : compteur, date, file de synchro. */
  captureEdits: (id: string) => Promise<void>;
  saveCursor: (id: string, cursor: Uint8Array) => Promise<void>;
  loadCursor: (id: string) => Promise<Uint8Array | null>;
  subscribe: (listener: (event: StoreEvent) => void) => () => void;
  close: () => Promise<void>;
};
