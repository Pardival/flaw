import { useState, type FormEvent, type ReactNode } from "react";

import { useTranslate } from "../../i18n/i18n.ts";
import type { MfaNotice } from "./phase.ts";
import { BACKUP_FILENAME, backupText, groupSecret } from "./policy.ts";

function alertMessage(notice: MfaNotice, phrase: (key: string) => string): string | null {
  switch (notice) {
    case null:
      return null;
    case "format":
      return phrase("codeFormat");
    case "rejected":
      return phrase("codeRejected");
    case "required":
      return phrase("codeRequired");
    case "limited":
      return phrase("tooMany");
    case "invalid":
      return phrase("invalidRequest");
    case "forbidden":
      return phrase("enrollRefused");
    case "network":
      return phrase("network");
    case "server":
      return phrase("server");
  }
}

function Alert({ notice }: { notice: MfaNotice }) {
  const t = useTranslate("mfa");
  const text = alertMessage(notice, t);
  if (text === null) {
    return null;
  }
  return <p role="alert">{text}</p>;
}

export function LoadingScreen() {
  const t = useTranslate("mfa");
  return (
    <p role="status" data-screen="loading">
      {t("loading")}
    </p>
  );
}

export function SignedOutScreen() {
  const t = useTranslate("mfa");
  return (
    <p role="status" data-screen="deconnecte">
      {t("signedOut")}
    </p>
  );
}

export function Connexion2faScreen({
  notice,
  pending,
  onSubmit,
  onUseRecovery,
}: {
  notice: MfaNotice;
  pending: boolean;
  onSubmit: (code: string) => void;
  onUseRecovery: () => void;
}) {
  const t = useTranslate("mfa");
  const [code, setCode] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit(code);
  }

  return (
    <form data-screen="connexion-2fa" method="post" onSubmit={submit} aria-labelledby="mfa-challenge-title">
      <h1 id="mfa-challenge-title">{t("challengeTitle")}</h1>
      <p>{t("challengeIntro")}</p>
      <Alert notice={notice} />
      <label htmlFor="mfa-totp">{t("totpLabel")}</label>
      <input
        id="mfa-totp"
        name="code"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        autoCorrect="off"
        spellCheck={false}
        required
        minLength={6}
        maxLength={6}
        pattern="[0-9]{6}"
        value={code}
        onChange={(event) => {
          setCode(event.currentTarget.value);
        }}
      />
      <button type="submit" disabled={pending}>
        {pending ? t("pending") : t("submitCode")}
      </button>
      <button type="button" onClick={onUseRecovery} disabled={pending}>
        {t("useRecovery")}
      </button>
    </form>
  );
}

export function ConnexionCodeSecoursScreen({
  notice,
  pending,
  onSubmit,
  onBack,
}: {
  notice: MfaNotice;
  pending: boolean;
  onSubmit: (code: string) => void;
  onBack: () => void;
}) {
  const t = useTranslate("mfa");
  const [code, setCode] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit(code);
  }

  return (
    <form data-screen="connexion-code-secours" method="post" onSubmit={submit} aria-labelledby="mfa-recovery-title">
      <h1 id="mfa-recovery-title">{t("recoveryTitle")}</h1>
      <p>{t("recoveryIntro")}</p>
      <Alert notice={notice} />
      <label htmlFor="mfa-recovery">{t("recoveryLabel")}</label>
      <input
        id="mfa-recovery"
        name="recoveryCode"
        type="text"
        autoComplete="off"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        required
        maxLength={64}
        value={code}
        onChange={(event) => {
          setCode(event.currentTarget.value);
        }}
        aria-describedby="mfa-recovery-hint"
      />
      <p id="mfa-recovery-hint">{t("recoveryHint")}</p>
      <button type="submit" disabled={pending}>
        {pending ? t("pending") : t("submitRecovery")}
      </button>
      <button type="button" onClick={onBack} disabled={pending}>
        {t("backToTotp")}
      </button>
    </form>
  );
}

export function Activation2faScreen({
  notice,
  pending,
  secret,
  otpauth,
  onSubmit,
  onSignOut,
}: {
  notice: MfaNotice;
  pending: boolean;
  secret: string | null;
  otpauth: string | null;
  onSubmit: (code: string) => void;
  onSignOut: () => void;
}) {
  const t = useTranslate("mfa");
  const [code, setCode] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit(code);
  }

  return (
    <section data-screen="activation-2fa" aria-labelledby="mfa-activation-title">
      <h1 id="mfa-activation-title">{t("activationTitle")}</h1>
      <p>{t("activationIntro")}</p>
      <Alert notice={notice} />
      {secret !== null && otpauth !== null ? (
        <>
          <p id="mfa-secret-label">{t("secretLabel")}</p>
          <p data-field="totp-secret" aria-labelledby="mfa-secret-label">
            {groupSecret(secret)}
          </p>
          <a href={otpauth}>{t("openApp")}</a>
          <form method="post" onSubmit={submit}>
            <label htmlFor="mfa-enroll-code">{t("totpLabel")}</label>
            <input
              id="mfa-enroll-code"
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoCorrect="off"
              spellCheck={false}
              required
              minLength={6}
              maxLength={6}
              pattern="[0-9]{6}"
              value={code}
              onChange={(event) => {
                setCode(event.currentTarget.value);
              }}
            />
            <button type="submit" disabled={pending}>
              {pending ? t("pending") : t("submitCode")}
            </button>
          </form>
        </>
      ) : null}
      <button type="button" onClick={onSignOut} disabled={pending}>
        {t("signOut")}
      </button>
    </section>
  );
}

function saveCodes(codes: readonly string[]): void {
  if (typeof document === "undefined") {
    return;
  }
  const blob = new Blob([backupText(codes)], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = BACKUP_FILENAME;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function printCodes(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.print();
}

export function CodesSecoursScreen({
  codes,
  copyNotice,
  onCopy,
  onContinue,
}: {
  codes: readonly string[];
  copyNotice: "copied" | "failed" | null;
  onCopy: () => void;
  onContinue: () => void;
}) {
  const t = useTranslate("mfa");
  return (
    <section data-screen="codes-secours" aria-labelledby="mfa-codes-title">
      <h1 id="mfa-codes-title">{t("codesTitle")}</h1>
      <p>{t("codesIntro")}</p>
      <ol data-count={codes.length}>
        {codes.map((code, index) => (
          <li key={index}>{code}</li>
        ))}
      </ol>
      <button type="button" onClick={onCopy}>
        {t("copy")}
      </button>
      <button
        type="button"
        onClick={() => {
          saveCodes(codes);
        }}
      >
        {t("save")}
      </button>
      <button type="button" onClick={printCodes}>
        {t("print")}
      </button>
      {copyNotice === "copied" ? <p role="status">{t("copied")}</p> : null}
      {copyNotice === "failed" ? <p role="alert">{t("copyFailed")}</p> : null}
      <button type="button" onClick={onContinue}>
        {t("continueTexts")}
      </button>
    </section>
  );
}

export function Reconfigurer2faScreen({
  notice,
  pending,
  onReconfigure,
  onSignOut,
}: {
  notice: MfaNotice;
  pending: boolean;
  onReconfigure: () => void;
  onSignOut: () => void;
}) {
  const t = useTranslate("mfa");
  return (
    <section data-screen="reconfigurer-2fa" aria-labelledby="mfa-reconfigure-title">
      <h1 id="mfa-reconfigure-title">{t("reconfigureTitle")}</h1>
      <p>{t("reconfigureBody")}</p>
      <Alert notice={notice} />
      <button type="button" onClick={onReconfigure} disabled={pending}>
        {pending ? t("pending") : t("reconfigureNow")}
      </button>
      <button type="button" onClick={onSignOut} disabled={pending}>
        {t("signOut")}
      </button>
    </section>
  );
}

export function screenPanel(props: {
  phaseName: "loading" | "connexion-2fa" | "connexion-code-secours" | "activation-2fa" | "codes-secours" | "reconfigurer-2fa" | "deconnecte";
  notice: MfaNotice;
  pending: boolean;
  secret: string | null;
  otpauth: string | null;
  codes: readonly string[];
  copyNotice: "copied" | "failed" | null;
  onTotp: (code: string) => void;
  onRecovery: (code: string) => void;
  onUseRecovery: () => void;
  onBackToTotp: () => void;
  onVerify: (code: string) => void;
  onSignOut: () => void;
  onCopy: () => void;
  onContinue: () => void;
  onReconfigure: () => void;
}): ReactNode {
  switch (props.phaseName) {
    case "loading":
      return <LoadingScreen />;
    case "deconnecte":
      return <SignedOutScreen />;
    case "connexion-2fa":
      return (
        <Connexion2faScreen
          notice={props.notice}
          pending={props.pending}
          onSubmit={props.onTotp}
          onUseRecovery={props.onUseRecovery}
        />
      );
    case "connexion-code-secours":
      return (
        <ConnexionCodeSecoursScreen
          notice={props.notice}
          pending={props.pending}
          onSubmit={props.onRecovery}
          onBack={props.onBackToTotp}
        />
      );
    case "activation-2fa":
      return (
        <Activation2faScreen
          notice={props.notice}
          pending={props.pending}
          secret={props.secret}
          otpauth={props.otpauth}
          onSubmit={props.onVerify}
          onSignOut={props.onSignOut}
        />
      );
    case "codes-secours":
      return (
        <CodesSecoursScreen
          codes={props.codes}
          copyNotice={props.copyNotice}
          onCopy={props.onCopy}
          onContinue={props.onContinue}
        />
      );
    case "reconfigurer-2fa":
      return (
        <Reconfigurer2faScreen
          notice={props.notice}
          pending={props.pending}
          onReconfigure={props.onReconfigure}
          onSignOut={props.onSignOut}
        />
      );
  }
}
