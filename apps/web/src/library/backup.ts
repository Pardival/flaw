import type { DocumentMode, LocalStore, PageFormat } from "../local-store/index.ts";

/**
 * Sauvegarde complète de la bibliothèque dans un seul fichier `.flaw` (JSON) :
 * métadonnées et état Yjs de chaque texte. La restauration ne remplace rien :
 * un texte déjà présent (même identifiant) est ignoré.
 */
export const BACKUP_FORMAT = "flaw-backup";
const BACKUP_VERSION = 1;
const MAX_BACKUP_BYTES = 512 * 1024 * 1024;
const MAX_DOCUMENTS = 5_000;

type BackupDocument = {
  id: string;
  title: string;
  mode: DocumentMode;
  pageFormat: PageFormat;
  fontFamily: string | null;
  baseFontSizePt: number | null;
  createdAt: string;
  update: string;
};

type Backup = { format: typeof BACKUP_FORMAT; version: number; exportedAt: string; documents: BackupDocument[] };

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export async function exportLibrary(store: LocalStore, now = new Date()): Promise<{ bytes: Uint8Array; name: string }> {
  const documents: BackupDocument[] = [];
  for (const doc of await store.listDocuments()) {
    documents.push({
      id: doc.id,
      title: doc.title,
      mode: doc.mode,
      pageFormat: doc.pageFormat,
      fontFamily: doc.fontFamily,
      baseFontSizePt: doc.baseFontSizePt,
      createdAt: doc.createdAt,
      update: toBase64(await store.exportUpdate(doc.id)),
    });
  }
  const backup: Backup = { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: now.toISOString(), documents };
  const day = now.toISOString().slice(0, 10);
  return { bytes: new TextEncoder().encode(JSON.stringify(backup)), name: `flaw-sauvegarde-${day}.flaw` };
}

export class BackupError extends Error {}

function parse(text: string): BackupDocument[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new BackupError("invalid");
  }
  const backup = data as Partial<Backup> | null;
  if (backup?.format !== BACKUP_FORMAT || typeof backup.version !== "number" || !Array.isArray(backup.documents)) {
    throw new BackupError("invalid");
  }
  if (backup.version > BACKUP_VERSION) {
    throw new BackupError("newer");
  }
  if (backup.documents.length > MAX_DOCUMENTS) {
    throw new BackupError("invalid");
  }
  for (const doc of backup.documents as unknown[]) {
    const item = doc as Partial<BackupDocument> | null;
    if (
      typeof item?.id !== "string" ||
      typeof item.title !== "string" ||
      typeof item.mode !== "string" ||
      typeof item.pageFormat !== "string" ||
      typeof item.update !== "string"
    ) {
      throw new BackupError("invalid");
    }
  }
  return backup.documents;
}

/** Restaure une sauvegarde ; renvoie le nombre de textes ajoutés et ignorés. */
export async function importLibrary(store: LocalStore, file: Blob): Promise<{ added: number; skipped: number }> {
  if (file.size > MAX_BACKUP_BYTES) {
    throw new BackupError("tooLarge");
  }
  const documents = parse(await file.text());
  const existing = new Set([...(await store.listDocuments()), ...(await store.listTrash())].map((doc) => doc.id));
  let added = 0;
  let skipped = 0;
  for (const item of documents) {
    if (existing.has(item.id)) {
      skipped += 1;
      continue;
    }
    try {
      const created = await store.createDocument({
        id: item.id,
        mode: item.mode,
        pageFormat: item.pageFormat,
        title: item.title,
        ...(typeof item.fontFamily === "string" ? { fontFamily: item.fontFamily } : {}),
        ...(typeof item.baseFontSizePt === "number" ? { baseFontSizePt: item.baseFontSizePt } : {}),
      });
      await store.importUpdate(created.id, fromBase64(item.update));
      added += 1;
    } catch {
      skipped += 1;
    }
  }
  return { added, skipped };
}
