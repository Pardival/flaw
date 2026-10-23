import Dexie, { type Table } from "dexie";

import type { DocumentMode, PageFormat, RestOperation } from "./types.ts";

export type DocumentRow = {
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
  cursor: string | null;
  contentPending: boolean;
  schemaVersion: number;
};

export type PreferenceRow = {
  key: string;
  value: string;
};

export type CounterRow = {
  id: string;
  wordCount: number;
};

export class LocalDatabase extends Dexie {
  documents!: Table<DocumentRow, string>;
  preferences!: Table<PreferenceRow, string>;
  operations!: Table<RestOperation, string>;
  counters!: Table<CounterRow, string>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      documents: "id, updatedAt, deletedAt",
      preferences: "key",
      operations: "id, documentId, status, createdAt, &idempotencyKey",
      counters: "id",
    });
  }
}
