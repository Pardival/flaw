import { fail } from "./errors.ts";

/** Type vérifié par le contenu, pas par l'extension (SEC-IMP-02). */
export type Sniffed = "zip" | "text";

function starts(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

export function sniff(bytes: Uint8Array): Sniffed {
  if (starts(bytes, [0x50, 0x4b, 0x03, 0x04]) || starts(bytes, [0x50, 0x4b, 0x05, 0x06])) {
    return "zip";
  }
  if (starts(bytes, [0xd0, 0xcf, 0x11, 0xe0])) {
    fail("ole");
  }
  if (starts(bytes, [0x25, 0x50, 0x44, 0x46]) || starts(bytes, [0x4d, 0x5a]) || starts(bytes, [0x7f, 0x45, 0x4c, 0x46])) {
    fail("unsupported");
  }
  return "text";
}
