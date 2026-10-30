import { ASSETS_MAP } from "@flaw/sync/src/index.ts";
import type * as Y from "yjs";

/**
 * Fichiers du texte (images, couvertures) rangés dans le Y.Doc : ils suivent le
 * texte partout (historique, sauvegarde, exports) sans aucune URL. La clé est
 * l'empreinte SHA-256 tronquée des octets : la même image n'est stockée qu'une fois.
 */
export type AssetKind = "jpeg" | "png";

export function assetKind(bytes: Uint8Array): AssetKind | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  return null;
}

export async function assetId(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return [...digest.subarray(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function putAsset(doc: Y.Doc, bytes: Uint8Array): Promise<string> {
  if (assetKind(bytes) === null) {
    throw new Error("image non reconnue");
  }
  const id = await assetId(bytes);
  const map = doc.getMap<Uint8Array>(ASSETS_MAP);
  if (!map.has(id)) {
    map.set(id, bytes);
  }
  return id;
}

export function getAsset(doc: Y.Doc, id: string): Uint8Array | null {
  const value = doc.getMap<unknown>(ASSETS_MAP).get(id);
  return value instanceof Uint8Array ? value : null;
}

const urls = new WeakMap<Y.Doc, Map<string, string>>();

/** URL locale (blob:) d'un fichier du texte, gardée tant que le texte est ouvert. */
export function assetUrl(doc: Y.Doc, id: string): string | null {
  let cache = urls.get(doc);
  if (cache === undefined) {
    cache = new Map();
    urls.set(doc, cache);
    doc.once("destroy", () => {
      for (const url of cache?.values() ?? []) URL.revokeObjectURL(url);
    });
  }
  const known = cache.get(id);
  if (known !== undefined) return known;
  const bytes = getAsset(doc, id);
  const kind = bytes === null ? null : assetKind(bytes);
  if (bytes === null || kind === null) return null;
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: `image/${kind}` }));
  cache.set(id, url);
  return url;
}

/** Fichiers encore désignés par le texte ou la couverture ; les autres peuvent partir. */
export function pruneAssets(doc: Y.Doc, used: ReadonlySet<string>): void {
  const map = doc.getMap<unknown>(ASSETS_MAP);
  doc.transact(() => {
    for (const key of [...map.keys()]) {
      if (!used.has(key)) map.delete(key);
    }
  });
}

/** Images désignées par le document, avec leurs octets, pour un export. */
export function exportAssets(doc: Y.Doc, json: { type: string; attrs?: Record<string, unknown>; content?: unknown[] }): Record<string, { bytes: Uint8Array; kind: AssetKind }> {
  const out: Record<string, { bytes: Uint8Array; kind: AssetKind }> = {};
  const walk = (node: { type: string; attrs?: Record<string, unknown>; content?: unknown[] }) => {
    if (node.type === "image" && typeof node.attrs?.asset === "string") {
      const bytes = getAsset(doc, node.attrs.asset);
      const kind = bytes === null ? null : assetKind(bytes);
      if (bytes !== null && kind !== null) out[node.attrs.asset] = { bytes, kind };
    }
    for (const child of node.content ?? []) walk(child as typeof node);
  };
  walk(json);
  return out;
}
