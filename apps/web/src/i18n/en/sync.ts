import type { sync as fr } from "../fr/sync.ts";
import type { Catalog } from "./catalog.ts";

export const sync: Catalog<typeof fr> = {
  saving: "Saving…",
  "saved-local": "Saved on this device",
  synced: "Synced",
  offline: "Offline",
  "auth-expired": "Sign-in required",
  "update-required": "Update required",
  error: "Sync failed",
  errorShort: "Sync failed",
  offlineDetail: "Nothing is lost: everything is saved on this device and will reach the server when the network returns.",
  lastSync: "Last synced: {{time}}",
  never: "Last synced: not yet on this device",
  authDetail: "You can keep writing: everything stays on this device.",
  reconnect: "Sign in again",
  updateDetail: "This text is read-only until the app is updated.",
  updateNow: "Update now",
  errorDetail: "Your changes are saved on this device. The server is not responding; retrying automatically.",
  retry: "Retry",
  exportCopy: "Export a copy",
  merged: "This text also changed on another device. The changes were merged.",
  compare: "Compare in history",
  close: "Close",
  trashedElsewhere:
    "This text was moved to the trash from another device. Your latest changes are kept there. Unless restored, it will be deleted in 30 days.",
  restore: "Restore",
  backToTexts: "Back to texts",
  storageFull:
    "This device is out of space. You are online: your changes go straight to the server. Free up space before working offline.",
  offlineStorageFull:
    "Do not close this page. Offline and out of space: your latest changes are only kept in this page. They will reach the server when the network returns, and this banner will disappear.",
  freeSpace: "How to free up space",
};
