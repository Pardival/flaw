import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  createAuthClient,
  normalizeIdentifier,
  type AuthClient,
  type Credentials,
  type PasswordChange,
} from "./api.ts";
import {
  nextPreserve,
  noticeFromChange,
  phaseAfterRejectedSignIn,
  phaseForgot,
  phaseFromMe,
  phaseFromProfile,
  showsLocalWork,
  withNotice,
  type AuthPhase,
} from "./phase.ts";
import { screenPanel } from "./screens.tsx";

export type AuthScreensProps = {
  children?: ReactNode;
  client?: AuthClient;
  /** Désactive le chargement de /api/v1/me. Réservé aux tests et à un hôte qui connaît déjà la phase. */
  initialPhase?: AuthPhase;
  onMfaRequired?: () => void;
};

export function AuthScreens({ children, client, initialPhase, onMfaRequired }: AuthScreensProps) {
  const owned = useRef<AuthClient | null>(null);
  const api = client ?? (owned.current ??= createAuthClient());
  const [phase, setPhase] = useState<AuthPhase>(initialPhase ?? { name: "loading" });
  const [pending, setPending] = useState(false);
  const preserveLocal = useRef(nextPreserve(initialPhase ?? { name: "loading" }, false));
  const alive = useRef(true);
  const busy = useRef(false);
  const onMfaRequiredRef = useRef(onMfaRequired);
  onMfaRequiredRef.current = onMfaRequired;

  const preserve = nextPreserve(phase, preserveLocal.current);
  preserveLocal.current = preserve;
  const showLocal = showsLocalWork(phase, preserve);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (initialPhase !== undefined) {
      return undefined;
    }
    let cancelled = false;
    void api.me().then((result) => {
      if (cancelled || !alive.current) {
        return;
      }
      if (result.ok === false && result.kind === "mfa_required") {
        onMfaRequiredRef.current?.();
      }
      setPhase(phaseFromMe(result, false));
    });
    return () => {
      cancelled = true;
    };
  }, [api, initialPhase]);

  async function submitSignIn(value: Credentials) {
    if (busy.current) {
      return;
    }
    busy.current = true;
    setPending(true);
    try {
      const signed = await api.signIn(value);
      if (!alive.current) {
        return;
      }
      if (!signed.ok) {
        if (signed.kind === "mfa_required") {
          onMfaRequiredRef.current?.();
        }
        setPhase((current) => phaseAfterRejectedSignIn(signed.kind, current));
        return;
      }
      const profile = await api.me();
      if (!alive.current) {
        return;
      }
      if (!profile.ok && profile.kind === "mfa_required") {
        onMfaRequiredRef.current?.();
      }
      setPhase(profile.ok ? phaseFromProfile(profile.data) : phaseFromMe(profile, true));
    } finally {
      busy.current = false;
      if (alive.current) {
        setPending(false);
      }
    }
  }

  async function submitChange(value: PasswordChange) {
    if (busy.current) {
      return;
    }
    busy.current = true;
    setPending(true);
    try {
      const changed = await api.changePassword(value);
      if (!alive.current) {
        return;
      }
      if (!changed.ok) {
        setPhase({ name: "nouveau-mot-de-passe", notice: noticeFromChange(changed.kind) });
        return;
      }
      const profile = await api.me();
      if (!alive.current) {
        return;
      }
      setPhase(profile.ok ? phaseFromProfile(profile.data) : phaseFromMe(profile, true));
    } finally {
      busy.current = false;
      if (alive.current) {
        setPending(false);
      }
    }
  }

  function openForgot(identifier: string) {
    setPhase((current) => phaseForgot(current));
    if (busy.current || normalizeIdentifier(identifier) === null) {
      return;
    }
    busy.current = true;
    setPending(true);
    void api
      .forgetPassword(identifier)
      .then((result) => {
        if (!alive.current) {
          return;
        }
        if (!result.ok && (result.kind === "limited" || result.kind === "invalid" || result.kind === "network")) {
          const notice = result.kind;
          setPhase((current) => withNotice(current, notice));
        }
      })
      .finally(() => {
        busy.current = false;
        if (alive.current) {
          setPending(false);
        }
      });
  }

  const notice = phase.name === "loading" || phase.name === "ready" ? null : phase.notice;
  const forgot = phase.name === "reconnexion-necessaire" ? phase.forgot : false;
  const panel =
    phase.name === "ready"
      ? null
      : screenPanel({
          phaseName: phase.name,
          notice,
          pending,
          forgot,
          onSubmit: (value) => {
            void submitSignIn(value);
          },
          onForgot: openForgot,
          onBack: () => {
            setPhase({ name: "connexion", notice: null });
          },
          onChangePassword: (value) => {
            void submitChange(value);
          },
        });

  return (
    <>
      {panel}
      {showLocal ? children : null}
    </>
  );
}
