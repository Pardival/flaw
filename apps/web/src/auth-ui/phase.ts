/**
 * Transitions des écrans D-001, D-002, D-004 et D-042.
 * La copie locale reste montée pendant la reconnexion.
 */
import type { AuthResult, FailureKind, MeProfile } from "./api.ts";

export type Notice =
  | "credential"
  | "limited"
  | "rejected"
  | "invalid"
  | "network"
  | "mfa"
  | "current"
  | null;

export type AuthPhase =
  | { name: "loading" }
  | { name: "ready" }
  | { name: "connexion"; notice: Notice }
  | { name: "connexion-mdp-oublie"; notice: Notice }
  | { name: "nouveau-mot-de-passe"; notice: Notice }
  | { name: "reconnexion-necessaire"; notice: Notice; forgot: boolean };

export function phaseFromProfile(profile: MeProfile): AuthPhase {
  if (profile.passwordMustChange) {
    return { name: "nouveau-mot-de-passe", notice: null };
  }
  return { name: "ready" };
}

function anonymousNotice(kind: FailureKind): Notice {
  if (kind === "mfa_required") {
    return "mfa";
  }
  if (kind === "limited") {
    return "limited";
  }
  if (kind === "invalid") {
    return "invalid";
  }
  if (kind === "rejected") {
    return "rejected";
  }
  return "network";
}

function reconnectNotice(kind: FailureKind): Notice {
  if (kind === "unauthorized") {
    return null;
  }
  return anonymousNotice(kind);
}

export function phaseFromFailure(kind: FailureKind, hadSession: boolean): AuthPhase {
  if (hadSession) {
    return { name: "reconnexion-necessaire", notice: reconnectNotice(kind), forgot: false };
  }
  if (kind === "unauthorized") {
    return { name: "connexion", notice: null };
  }
  return { name: "connexion", notice: anonymousNotice(kind) };
}

export function phaseFromMe(result: AuthResult<MeProfile>, hadSession: boolean): AuthPhase {
  if (result.ok) {
    return phaseFromProfile(result.data);
  }
  return phaseFromFailure(result.kind, hadSession);
}

export function phaseAfterRejectedSignIn(kind: FailureKind, current: AuthPhase): AuthPhase {
  const reconnecting = current.name === "reconnexion-necessaire";
  const forgot = reconnecting ? current.forgot : false;
  if (kind === "unauthorized") {
    return reconnecting
      ? { name: "reconnexion-necessaire", notice: "credential", forgot }
      : { name: "connexion-mdp-oublie", notice: "credential" };
  }
  const notice = anonymousNotice(kind);
  if (reconnecting) {
    return { name: "reconnexion-necessaire", notice, forgot };
  }
  if (current.name === "connexion-mdp-oublie") {
    return { name: "connexion-mdp-oublie", notice };
  }
  return { name: "connexion", notice };
}

export function noticeFromChange(kind: FailureKind): Notice {
  if (kind === "unauthorized") {
    return "current";
  }
  if (kind === "rejected") {
    return "rejected";
  }
  if (kind === "limited") {
    return "limited";
  }
  if (kind === "invalid") {
    return "invalid";
  }
  if (kind === "mfa_required") {
    return "mfa";
  }
  return "network";
}

export function phaseForgot(phase: AuthPhase): AuthPhase {
  if (phase.name === "reconnexion-necessaire") {
    return { name: "reconnexion-necessaire", notice: phase.notice, forgot: true };
  }
  const notice = phase.name === "connexion" || phase.name === "connexion-mdp-oublie" ? phase.notice : null;
  return { name: "connexion-mdp-oublie", notice };
}

export function withNotice(phase: AuthPhase, notice: Notice): AuthPhase {
  switch (phase.name) {
    case "loading":
    case "ready":
      return phase;
    case "reconnexion-necessaire":
      return { name: phase.name, notice, forgot: phase.forgot };
    case "connexion":
    case "connexion-mdp-oublie":
    case "nouveau-mot-de-passe":
      return { name: phase.name, notice };
  }
}

/** Vrai une fois qu'une session a affiché le travail local, y compris pendant D-004 imposé ensuite. */
export function nextPreserve(phase: AuthPhase, preserve: boolean): boolean {
  if (phase.name === "ready" || phase.name === "reconnexion-necessaire") {
    return true;
  }
  if (phase.name === "nouveau-mot-de-passe") {
    return preserve;
  }
  return false;
}

export function showsLocalWork(phase: AuthPhase, preserve: boolean): boolean {
  if (phase.name === "ready" || phase.name === "reconnexion-necessaire") {
    return true;
  }
  return phase.name === "nouveau-mot-de-passe" && preserve;
}
