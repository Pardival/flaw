/**
 * Écrans D-003 (connexion-2fa, connexion-code-secours), D-005, D-006 et D-007.
 * Les textes restent cachés tant que la phase n'est pas « ready ».
 */
import type { FailureKind } from "../api.ts";

export type MfaNotice =
  | "format"
  | "rejected"
  | "required"
  | "limited"
  | "invalid"
  | "forbidden"
  | "network"
  | "server"
  | null;

export type EnrollmentBundle = {
  secret: string;
  otpauth: string;
  codes: readonly string[];
};

export type MfaPhase =
  | { name: "loading" }
  | { name: "connexion-2fa"; notice: MfaNotice }
  | { name: "connexion-code-secours"; notice: MfaNotice }
  | { name: "activation-2fa"; notice: MfaNotice; enrollment: EnrollmentBundle | null }
  | { name: "codes-secours"; codes: readonly string[] }
  | { name: "reconfigurer-2fa"; notice: MfaNotice }
  | { name: "deconnecte" }
  | { name: "ready" };

export function challengePhase(notice: MfaNotice = null): MfaPhase {
  return { name: "connexion-2fa", notice };
}

export function recoveryPhase(notice: MfaNotice = null): MfaPhase {
  return { name: "connexion-code-secours", notice };
}

export function activationPhase(
  enrollment: EnrollmentBundle | null,
  notice: MfaNotice = null,
): Extract<MfaPhase, { name: "activation-2fa" }> {
  return { name: "activation-2fa", notice, enrollment };
}

export function codesPhase(codes: readonly string[]): MfaPhase {
  return { name: "codes-secours", codes };
}

export function reconfigurePhase(notice: MfaNotice = null): MfaPhase {
  return { name: "reconfigurer-2fa", notice };
}

export function noticeFromKind(kind: FailureKind): MfaNotice {
  switch (kind) {
    case "mfa_required":
      return "required";
    case "unauthorized":
      return "rejected";
    case "limited":
      return "limited";
    case "invalid":
    case "rejected":
      return "invalid";
    case "forbidden":
      return "forbidden";
    case "network":
      return "network";
    case "server":
      return "server";
  }
}

/** Les textes locaux ne s'affichent qu'une fois les codes de secours quittés. */
export function showsTexts(phase: MfaPhase): boolean {
  return phase.name === "ready";
}

export function phaseAfterSignOut(
  succeeded: boolean,
  current: Extract<MfaPhase, { name: "activation-2fa" }>,
  notice: MfaNotice,
): MfaPhase {
  if (succeeded) {
    return { name: "deconnecte" };
  }
  return { ...current, notice };
}
