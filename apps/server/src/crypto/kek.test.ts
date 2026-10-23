import { describe, expect, it } from "vitest";

import { sameKeyBytes } from "./kek.ts";

describe("comparaison des clés décodées", () => {
  it("compare les octets, pas le texte", () => {
    const left = Uint8Array.from({ length: 32 }, (_, index) => index);
    const right = Uint8Array.from(left);
    expect(sameKeyBytes(left, right)).toBe(true);
    right[3] = 9;
    expect(sameKeyBytes(left, right)).toBe(false);
    expect(sameKeyBytes(left, left.slice(0, 31))).toBe(false);
    expect(left[3]).toBe(3);
  });
});
