import { describe, expect, it } from "vitest";

import { activationPhase, noticeFromKind, phaseAfterSignOut, showsTexts } from "./phase.ts";

describe("phases MFA", () => {
  it("traduit les échecs du client partagé", () => {
    expect(noticeFromKind("mfa_required")).toBe("required");
    expect(noticeFromKind("unauthorized")).toBe("rejected");
    expect(noticeFromKind("limited")).toBe("limited");
    expect(noticeFromKind("forbidden")).toBe("forbidden");
    expect(noticeFromKind("invalid")).toBe("invalid");
    expect(noticeFromKind("rejected")).toBe("invalid");
    expect(noticeFromKind("network")).toBe("network");
    expect(noticeFromKind("server")).toBe("server");
  });

  it("cache les textes hors de la phase prête", () => {
    expect(showsTexts({ name: "ready" })).toBe(true);
    expect(showsTexts({ name: "connexion-2fa", notice: null })).toBe(false);
    expect(showsTexts({ name: "codes-secours", codes: [] })).toBe(false);
    expect(showsTexts({ name: "reconfigurer-2fa", notice: null })).toBe(false);
    expect(showsTexts({ name: "activation-2fa", notice: null, enrollment: null })).toBe(false);
  });

  it("retire la clé après la déconnexion", () => {
    const current = activationPhase({ secret: "A".repeat(32), otpauth: "otpauth://totp/Flaw:compte", codes: [] }, null);
    expect(phaseAfterSignOut(true, current, null)).toEqual({ name: "deconnecte" });
    expect(phaseAfterSignOut(false, current, "network")).toEqual({ ...current, notice: "network" });
  });
});
