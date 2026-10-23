import {
  DOCUMENT_MODES,
  IMPORT_SOURCES,
  LocalStoreError,
  PAGE_FORMATS,
  type DocumentMode,
  type ImportSource,
  type PageFormat,
  type RestOperation,
} from "./types.ts";
import { isUuidV7, normalizeUuidV7 } from "./uuid.ts";

const SECRET = /token|secret|password|passwd|cookie|authorization|jwt|bearer|credential|api[-_]?key/i;

const DOCUMENT_PATH =
  /^\/api\/v1\/documents(?:\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\/(?:restore|content|sync))?)?(?:\?permanent=true)?$/;

export const DOCUMENTS_COLLECTION = "/api/v1/documents";

const ALLOWED_HEADERS = new Set(["idempotency-key", "x-flaw-schema-version"]);

export function isSafeDocumentPath(path: string): boolean {
  return DOCUMENT_PATH.test(path);
}

export function assertDatabaseName(name: string): void {
  if (!/^[a-z0-9-]{1,64}$/.test(name)) {
    throw new LocalStoreError("invalid", "Nom de base local invalide.");
  }
}

export function assertMode(value: string): asserts value is DocumentMode {
  if (!(DOCUMENT_MODES as readonly string[]).includes(value)) {
    throw new LocalStoreError("invalid", "Mode inconnu.");
  }
}

export function assertPageFormat(value: string): asserts value is PageFormat {
  if (!(PAGE_FORMATS as readonly string[]).includes(value)) {
    throw new LocalStoreError("invalid", "Format de page inconnu.");
  }
}

export function assertTitle(title: string): void {
  if (title.length > 300) {
    throw new LocalStoreError("invalid", "Le titre dépasse 300 caractères.");
  }
}

export function assertFont(value: string): void {
  if (value.length < 1 || value.length > 200) {
    throw new LocalStoreError("invalid", "Police invalide.");
  }
}

export function assertFontSize(value: number): void {
  if (!Number.isInteger(value) || value < 6 || value > 48) {
    throw new LocalStoreError("invalid", "Taille de police invalide.");
  }
}

export function assertImportSource(value: string): asserts value is ImportSource {
  if (!(IMPORT_SOURCES as readonly string[]).includes(value)) {
    throw new LocalStoreError("invalid", "Source d'import inconnue.");
  }
}

export function assertPreference(key: string, value: string): void {
  if (!/^[a-z][A-Za-z0-9]{0,63}$/.test(key)) {
    throw new LocalStoreError("invalid", "Clé de préférence invalide.");
  }
  if (SECRET.test(key) || SECRET.test(value)) {
    throw new LocalStoreError("secret", "Aucun jeton ni secret dans le stockage local.");
  }
  if (value.length > 2000) {
    throw new LocalStoreError("invalid", "Préférence trop longue.");
  }
}

export function assertIndex(index: number, length: number): void {
  if (!Number.isInteger(index) || index < 0 || index > length) {
    throw new LocalStoreError("invalid", "Index invalide.");
  }
}

export function documentPath(id: string, suffix?: "restore" | "content" | "sync" | "permanent"): string {
  const uuid = normalizeUuidV7(id);
  if (suffix === "permanent") {
    return `/api/v1/documents/${uuid}?permanent=true`;
  }
  if (suffix) {
    return `/api/v1/documents/${uuid}/${suffix}`;
  }
  return `/api/v1/documents/${uuid}`;
}

export function assertOperation(operation: RestOperation): void {
  if (!isUuidV7(operation.documentId) || !isSafeDocumentPath(operation.path)) {
    throw new LocalStoreError("invalid", "Chemin REST invalide.");
  }
  if (operation.path.toLowerCase().includes("title") || operation.path.includes(" ")) {
    throw new LocalStoreError("invalid", "Le chemin ne peut pas porter de titre.");
  }
  if (operation.idempotencyKey.length === 0 || operation.idempotencyKey.length > 128) {
    throw new LocalStoreError("invalid", "Idempotency-Key invalide.");
  }
  for (const key of Object.keys(operation.headers)) {
    if (!ALLOWED_HEADERS.has(key) || SECRET.test(key)) {
      throw new LocalStoreError("secret", "En-tête refusé dans la file locale.");
    }
  }
  const headerKey = operation.headers["idempotency-key"];
  if (headerKey !== operation.idempotencyKey) {
    throw new LocalStoreError("invalid", "Idempotency-Key absente de l'opération.");
  }
  for (const value of Object.values(operation.headers)) {
    if (SECRET.test(value) && value !== operation.idempotencyKey) {
      throw new LocalStoreError("secret", "Secret refusé dans la file locale.");
    }
  }
}

export function isQuotaError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as { name?: unknown; code?: unknown; inner?: unknown };
    if (record.name === "QuotaExceededError" || record.code === 22 || record.code === "QuotaExceededError") {
      return true;
    }
    current = record.inner;
  }
  return false;
}
