import { useSyncExternalStore } from "react";

/**
 * États de synchronisation (A-025, tableau P8) et bandeaux.
 * Un seul état global : l'indicateur de la liste et celui de l'éditeur lisent le même.
 */
export type SyncState =
  | "saving"
  | "saved-local"
  | "synced"
  | "offline"
  | "auth-expired"
  | "update-required"
  | "error";

export type Banner =
  | { kind: "merged"; documentId: string }
  | { kind: "trashed-elsewhere"; documentId: string }
  | { kind: "storage-full" }
  | { kind: "offline-storage-full" };

export type SyncSnapshot = {
  state: SyncState;
  lastSyncedAt: string | null;
  banners: Banner[];
};

type Flags = {
  online: boolean;
  connected: boolean;
  /** Textes ouverts reliés au serveur : sans texte ouvert, la connexion n'est pas attendue. */
  attached: number;
  pending: number;
  queued: number;
  saving: boolean;
  authExpired: boolean;
  updateRequired: boolean;
  storageFull: boolean;
  pendingSince: number | null;
};

/** Cinq minutes en ligne sans synchro : « Synchronisation impossible » (D-044). */
export const SYNC_ERROR_AFTER_MS = 5 * 60 * 1000;

const flags: Flags = {
  online: typeof navigator === "undefined" ? true : navigator.onLine,
  connected: false,
  attached: 0,
  pending: 0,
  queued: 0,
  saving: false,
  authExpired: false,
  updateRequired: false,
  storageFull: false,
  pendingSince: null,
};

let snapshot: SyncSnapshot = { state: "saved-local", lastSyncedAt: null, banners: [] };
const transient = new Map<string, Banner>();
const shownOnce = new Set<string>();
const listeners = new Set<() => void>();

function derive(): SyncState {
  if (flags.updateRequired) {
    return "update-required";
  }
  if (flags.authExpired) {
    return "auth-expired";
  }
  if (!flags.online) {
    return "offline";
  }
  if (flags.pendingSince !== null && Date.now() - flags.pendingSince > SYNC_ERROR_AFTER_MS) {
    return "error";
  }
  if (flags.saving) {
    return "saving";
  }
  if (flags.pending + flags.queued > 0 || (flags.attached > 0 && !flags.connected)) {
    return "saved-local";
  }
  return "synced";
}

function emit(): void {
  const state = derive();
  const banners = [...transient.values()];
  if (flags.storageFull) {
    banners.push(flags.online ? { kind: "storage-full" } : { kind: "offline-storage-full" });
  }
  const lastSyncedAt = state === "synced" ? new Date().toISOString() : snapshot.lastSyncedAt;
  snapshot = { state, lastSyncedAt, banners };
  for (const listener of listeners) {
    listener();
  }
}

export function updateSync(patch: Partial<Flags>): void {
  Object.assign(flags, patch);
  const waiting = flags.pending + flags.queued;
  if (waiting > 0 && flags.online && flags.pendingSince === null) {
    flags.pendingSince = Date.now();
  } else if (waiting === 0 || !flags.online) {
    flags.pendingSince = null;
  }
  emit();
}

export function readFlags(): Readonly<Flags> {
  return flags;
}

/** Bandeau de réunion : une seule fois par texte et par session (AC-029). */
export function showBannerOnce(banner: Banner): void {
  const key = `${banner.kind}:${"documentId" in banner ? banner.documentId : ""}`;
  if (shownOnce.has(key)) {
    return;
  }
  shownOnce.add(key);
  transient.set(key, banner);
  emit();
}

export function dismissBanner(banner: Banner): void {
  transient.delete(`${banner.kind}:${"documentId" in banner ? banner.documentId : ""}`);
  emit();
}

export function useSyncStatus(): SyncSnapshot {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
    () => snapshot,
  );
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    updateSync({ online: true });
  });
  window.addEventListener("offline", () => {
    updateSync({ online: false });
  });
  // Réévalue « Synchronisation impossible » sans attendre un autre événement.
  window.setInterval(() => {
    if (flags.pendingSince !== null) {
      emit();
    }
  }, 30_000);
}
