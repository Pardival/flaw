import "fake-indexeddb/auto";

import { afterEach, describe, expect, it } from "vitest";

import { openLocalStore, type LocalStore } from "../local-store/index.ts";
import { exportLibrary, importLibrary } from "./backup.ts";

const opened: LocalStore[] = [];
let serial = 0;

async function freshStore(): Promise<LocalStore> {
  serial += 1;
  const store = await openLocalStore({ databaseName: `flaw-backup-${String(serial)}`, localOnly: true });
  opened.push(store);
  return store;
}

afterEach(async () => {
  for (const store of opened.splice(0)) {
    await store.close().catch(() => undefined);
  }
});

describe("version de bureau : stockage sans serveur", () => {
  it("ne met aucune opération en file et ne laisse rien « en attente »", async () => {
    const store = await freshStore();
    const doc = await store.createDocument({ mode: "novel", pageFormat: "novel_13x20", title: "Local" });
    await store.insertText(doc.id, 0, "Bonjour le monde");
    await store.renameDocument(doc.id, "Local, renommé");
    expect(await store.pendingOperations()).toEqual([]);
    expect(await store.hasUnsynced()).toBe(false);
  });
});

describe("sauvegarde de la bibliothèque", () => {
  it("restaure les textes, leur contenu et leurs réglages dans une autre bibliothèque", async () => {
    const source = await freshStore();
    const novel = await source.createDocument({ mode: "novel", pageFormat: "trade_15x23", title: "Mon roman" });
    await source.insertText(novel.id, 0, "Il était une fois");
    await source.captureEdits(novel.id);
    await source.createDocument({ mode: "screenplay", pageFormat: "us_letter", title: "Mon script" });

    const { bytes, name } = await exportLibrary(source, new Date("2026-10-30T10:00:00Z"));
    expect(name).toBe("flaw-sauvegarde-2026-10-30.flaw");

    const target = await freshStore();
    const result = await importLibrary(target, new Blob([bytes as BlobPart]));
    expect(result).toEqual({ added: 2, skipped: 0 });
    const restored = await target.listDocuments();
    expect(restored.map((doc) => doc.title).sort()).toEqual(["Mon roman", "Mon script"]);
    const roman = restored.find((doc) => doc.title === "Mon roman");
    expect(roman?.pageFormat).toBe("trade_15x23");
    expect(roman?.id).toBe(novel.id);
    expect(await target.exportUpdate(novel.id)).toEqual(await source.exportUpdate(novel.id));

    // Restaurer deux fois ne duplique rien.
    expect(await importLibrary(target, new Blob([bytes as BlobPart]))).toEqual({ added: 0, skipped: 2 });
  });

  it("refuse un fichier qui n'est pas une sauvegarde Flaw", async () => {
    const store = await freshStore();
    await expect(importLibrary(store, new Blob(["{\"hello\":1}"]))).rejects.toThrow("invalid");
    await expect(importLibrary(store, new Blob(["pas du JSON"]))).rejects.toThrow("invalid");
    await expect(
      importLibrary(store, new Blob([JSON.stringify({ format: "flaw-backup", version: 99, documents: [] })])),
    ).rejects.toThrow("newer");
    expect(await store.listDocuments()).toEqual([]);
  });
});
