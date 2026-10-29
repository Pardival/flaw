import Dexie, { type Table } from "dexie";

/**
 * Instantané local `before_merge` (A-010) : l'état du texte sur cet appareil juste
 * avant qu'une modification venue d'ailleurs soit fusionnée. L'historique (T-032) le lit.
 */
export type BeforeMergeRow = {
  id?: number;
  documentId: string;
  createdAt: string;
  update: Uint8Array;
};

class BeforeMergeDatabase extends Dexie {
  snapshots!: Table<BeforeMergeRow, number>;

  constructor() {
    super("flaw-before-merge");
    this.version(1).stores({ snapshots: "++id, documentId, createdAt" });
  }
}

let database: BeforeMergeDatabase | null = null;

function db(): BeforeMergeDatabase {
  database ??= new BeforeMergeDatabase();
  return database;
}

const KEEP_PER_DOCUMENT = 20;

export async function saveBeforeMerge(documentId: string, update: Uint8Array): Promise<void> {
  const table = db().snapshots;
  await table.add({ documentId, createdAt: new Date().toISOString(), update });
  const rows = await table.where("documentId").equals(documentId).sortBy("createdAt");
  const extra = rows.length - KEEP_PER_DOCUMENT;
  if (extra > 0) {
    await table.bulkDelete(rows.slice(0, extra).flatMap((row) => (row.id === undefined ? [] : [row.id])));
  }
}

export async function listBeforeMerge(documentId: string): Promise<BeforeMergeRow[]> {
  return (await db().snapshots.where("documentId").equals(documentId).sortBy("createdAt")).reverse();
}

export async function clearBeforeMerge(): Promise<void> {
  await db().delete();
  database = null;
}
