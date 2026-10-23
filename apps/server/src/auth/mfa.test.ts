/**
 * TOTP RFC 6238 et codes de secours (A-012, ARC-SUM 0.4.18).
 * Le rejeu d'un même pas est refusé. Le pas suivant de la fenêtre reste accepté.
 */
import { describe, expect, it } from "vitest";

import {
  decodeBase32,
  encodeBase32,
  hotp,
  matchTotp,
  normalizeRecoveryCode,
  recoveryCode,
  totpStep,
} from "./mfa.ts";

const RFC_SECRET = new TextEncoder().encode("12345678901234567890");

describe("TOTP RFC 6238", () => {
  it("reproduit le vecteur SHA-1 du pas 1 (59 s)", () => {
    expect(totpStep(new Date(59_000))).toBe(1);
    expect(hotp(RFC_SECRET, 1, 8)).toBe("94287082");
    expect(hotp(RFC_SECRET, 1, 6)).toBe("287082");
  });

  it("refuse le rejeu du même pas et accepte le pas suivant (A-012)", () => {
    const at = new Date(59_000);
    const code = hotp(RFC_SECRET, 1, 6);
    expect(matchTotp(RFC_SECRET, code, at, null)).toBe(1);
    expect(matchTotp(RFC_SECRET, code, at, 1)).toBeNull();
    const later = new Date(59_000 + 30_000);
    const next = hotp(RFC_SECRET, 2, 6);
    expect(matchTotp(RFC_SECRET, code, later, 1)).toBeNull();
    expect(matchTotp(RFC_SECRET, next, later, 1)).toBe(2);
  });

  it("encode et décode le base32 sans perdre les octets", () => {
    const raw = Uint8Array.from([0x48, 0x65, 0x6c, 0x6c, 0x6f]);
    const encoded = encodeBase32(raw);
    expect(decodeBase32(encoded)).toEqual(raw);
    expect(decodeBase32("!!!")).toBeNull();
  });
});

describe("codes de secours", () => {
  it("produit 16 caractères base32 groupés et refuse un code trop court (AC-066)", () => {
    const code = recoveryCode();
    expect(code).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/);
    expect(normalizeRecoveryCode(code)).toHaveLength(16);
    expect(normalizeRecoveryCode("ABCD")).toBeNull();
    expect(normalizeRecoveryCode("abcd-efgh-ijkl-mnop")).toBe("ABCDEFGHIJKLMNOP");
    expect(normalizeRecoveryCode("ABCD-EFGH-IJKL-MN0P")).toBeNull();
  });
});
