import { useEffect, useRef, useState, type ReactNode } from "react";
import { hideBootSplash } from "../../shell/boot-splash.ts";

import { createAuthClient, type AuthClient, type Credentials } from "../api.ts";

import {
  dropEnrollment,
  enrollmentAccount,
  enrollFresh,
  enrollOnce,
  signOutOfEnrollment,
  submitRecoveryCode,
  submitTotpCode,
  verifyEnrollmentCode,
} from "./flow.ts";
import { t } from "../../i18n/i18n.ts";
import {
  activationPhase,
  challengePhase,
  codesPhase,
  phaseAfterSignOut,
  reconfigurePhase,
  recoveryPhase,
  showsTexts,
  type MfaPhase,
} from "./phase.ts";
import { RECOVERY_CODE_COUNT, backupText } from "./policy.ts";
import { screenPanel } from "./screens.tsx";

export type MfaIntent = "challenge" | "enroll" | "reconfigure";

export type MfaScreensProps = {
  children?: ReactNode;
  client?: AuthClient;
  /** Réservé aux tests et à un hôte qui a déjà la phase. Aucun appel au montage. */
  initialPhase?: MfaPhase;
  /** Sans initialPhase : défi de connexion, enrôlement, ou bandeau de reconfiguration. */
  intent?: MfaIntent;
  credentials?: Credentials;
  /** Libellé du compte dans le lien otpauth://. Sinon l'identifiant, sinon le repli du catalogue. */
  accountLabel?: string;
  onSignedOut?: () => void;
};

function phaseForIntent(intent: MfaIntent): MfaPhase {
  switch (intent) {
    case "challenge":
      return challengePhase();
    case "reconfigure":
      return reconfigurePhase();
    case "enroll":
      return { name: "loading" };
  }
}

async function writeBackup(text: string): Promise<boolean> {
  if (typeof navigator === "undefined" || navigator.clipboard === undefined) {
    return false;
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function MfaScreens({
  children,
  client,
  initialPhase,
  intent = "challenge",
  credentials,
  accountLabel,
  onSignedOut,
}: MfaScreensProps) {
  const owned = useRef<AuthClient | null>(null);
  const api = client ?? (owned.current ??= createAuthClient());
  const [phase, setPhase] = useState<MfaPhase>(initialPhase ?? phaseForIntent(intent));
  const [pending, setPending] = useState(false);
  // Un écran à remplir (connexion, 2FA) remplace le logo de chargement.
  useEffect(() => {
    if (phase.name !== "loading" && phase.name !== "ready") {
      hideBootSplash();
    }
  }, [phase.name]);
  const [copyNotice, setCopyNotice] = useState<"copied" | "failed" | null>(null);
  const alive = useRef(true);
  const busy = useRef(false);
  const onSignedOutRef = useRef(onSignedOut);
  onSignedOutRef.current = onSignedOut;
  const credentialsRef = useRef(credentials);
  credentialsRef.current = credentials;
  const accountLabelRef = useRef(accountLabel);
  accountLabelRef.current = accountLabel;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (initialPhase !== undefined || intent !== "enroll") {
      return undefined;
    }
    let cancelled = false;
    const label = enrollmentAccount(accountLabelRef.current, credentialsRef.current, t("mfa:accountFallback"));
    void enrollOnce(api, label, t("mfa:issuer")).then((outcome) => {
      if (cancelled || !alive.current) {
        return;
      }
      if (outcome.ok) {
        setPhase((current) => {
          if (current.name === "activation-2fa" && current.enrollment !== null) {
            return current;
          }
          return activationPhase(outcome.enrollment);
        });
        return;
      }
      setPhase((current) => {
        if (current.name === "activation-2fa" && current.enrollment !== null) {
          return current;
        }
        return activationPhase(null, outcome.notice);
      });
    });
    return () => {
      cancelled = true;
    };
  }, [api, initialPhase, intent]);

  async function run(action: () => Promise<void>) {
    if (busy.current) {
      return;
    }
    busy.current = true;
    setPending(true);
    try {
      await action();
    } finally {
      busy.current = false;
      if (alive.current) {
        setPending(false);
      }
    }
  }

  function labelNow(): string {
    return enrollmentAccount(accountLabelRef.current, credentialsRef.current, t("mfa:accountFallback"));
  }

  const notice =
    phase.name === "loading" || phase.name === "ready" || phase.name === "deconnecte" || phase.name === "codes-secours"
      ? null
      : phase.notice;
  const enrollment = phase.name === "activation-2fa" ? phase.enrollment : null;
  const codes = phase.name === "codes-secours" ? phase.codes : [];

  const panel =
    phase.name === "ready"
      ? null
      : screenPanel({
          phaseName: phase.name,
          notice,
          pending,
          secret: enrollment?.secret ?? null,
          otpauth: enrollment?.otpauth ?? null,
          codes: phase.name === "codes-secours" ? codes : [],
          copyNotice,
          onTotp: (code) => {
            void run(async () => {
              const outcome = await submitTotpCode(api, credentialsRef.current, code);
              if (!alive.current) {
                return;
              }
              setPhase(outcome.ok ? { name: "ready" } : challengePhase(outcome.notice));
            });
          },
          onRecovery: (code) => {
            void run(async () => {
              const outcome = await submitRecoveryCode(api, credentialsRef.current, code);
              if (!alive.current) {
                return;
              }
              setPhase(outcome.ok ? reconfigurePhase() : recoveryPhase(outcome.notice));
            });
          },
          onUseRecovery: () => {
            setCopyNotice(null);
            setPhase(recoveryPhase());
          },
          onBackToTotp: () => {
            setPhase(challengePhase());
          },
          onVerify: (code) => {
            void run(async () => {
              const current = phaseRef.current;
              const currentCodes = current.name === "activation-2fa" ? current.enrollment?.codes : undefined;
              const outcome = await verifyEnrollmentCode(api, code);
              if (!alive.current) {
                return;
              }
              if (outcome.ok && currentCodes !== undefined && currentCodes.length === RECOVERY_CODE_COUNT) {
                setPhase(codesPhase(currentCodes));
                return;
              }
              if (current.name === "activation-2fa") {
                setPhase(activationPhase(current.enrollment, outcome.ok ? "server" : outcome.notice));
              }
            });
          },
          onSignOut: () => {
            void run(async () => {
              const current = phaseRef.current;
              const outcome = await signOutOfEnrollment(api);
              if (!alive.current) {
                return;
              }
              if (outcome.ok) {
                setPhase({ name: "deconnecte" });
                onSignedOutRef.current?.();
                return;
              }
              if (current.name === "activation-2fa") {
                setPhase(phaseAfterSignOut(false, current, outcome.notice));
                return;
              }
              if (current.name === "reconfigurer-2fa") {
                setPhase(reconfigurePhase(outcome.notice));
              }
            });
          },
          onCopy: () => {
            const current = phaseRef.current;
            if (current.name !== "codes-secours") {
              return;
            }
            void writeBackup(backupText(current.codes)).then((ok) => {
              if (alive.current) {
                setCopyNotice(ok ? "copied" : "failed");
              }
            });
          },
          onContinue: () => {
            dropEnrollment(api);
            setCopyNotice(null);
            setPhase({ name: "ready" });
          },
          onReconfigure: () => {
            void run(async () => {
              const outcome = await enrollFresh(api, labelNow(), t("mfa:issuer"));
              if (!alive.current) {
                return;
              }
              if (outcome.ok) {
                setPhase(activationPhase(outcome.enrollment));
                return;
              }
              setPhase(reconfigurePhase(outcome.notice));
            });
          },
        });

  return (
    <>
      {panel}
      {showsTexts(phase) ? children : null}
    </>
  );
}
