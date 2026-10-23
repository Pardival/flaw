import { LocalStoreError } from "./types.ts";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuidV7(value: string): boolean {
  return UUID_V7.test(value);
}

export function normalizeUuidV7(value: string): string {
  const id = value.toLowerCase();
  if (!isUuidV7(id)) {
    throw new LocalStoreError("invalid", "Identifiant UUIDv7 requis.");
  }
  return id;
}

export function uuidV7(timestamp = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const time = BigInt(timestamp);
  bytes[0] = Number((time >> 40n) & 0xffn);
  bytes[1] = Number((time >> 32n) & 0xffn);
  bytes[2] = Number((time >> 24n) & 0xffn);
  bytes[3] = Number((time >> 16n) & 0xffn);
  bytes[4] = Number((time >> 8n) & 0xffn);
  bytes[5] = Number(time & 0xffn);
  const sixth = bytes[6] ?? 0;
  const eighth = bytes[8] ?? 0;
  bytes[6] = (sixth & 0x0f) | 0x70;
  bytes[8] = (eighth & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
