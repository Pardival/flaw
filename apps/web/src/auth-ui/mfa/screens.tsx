import { useState, type FormEvent, type ReactNode } from "react";

import { messages } from "./messages.fr.ts";
import type { MfaNotice } from "./phase.ts";
import { BACKUP_FILENAME, backupText, groupSecret } from "./policy.ts";

function alertMessage(notice: MfaNotice): string | null {
  switch (notice) {
    case null:
      return null;
    case "format":
      return messages.codeFormat;
    case "rejected":
      return messages.codeRejected;
    case "required":
      return messages.codeRequired;
    case "limited":
      return messages.tooMany;
    case "invalid":
      return messages.invalidRequest;
    case "forbidden":
      return messages.enrollRefused;
    case "network":
      return messages.network;
    case "server":
      return messages.server;
  }
}

function Alert({ notice }: { notice: MfaNotice }) {
  const text = alertMessage(notice);
  if (text === null) {
    return null;
  }
  return <p role="alert">{text}</p>;
}

export function LoadingScreen() {
  return (
    <p role="status" data-screen="loading">
      {messages.loading}
    </p>
  );
}

export function SignedOutScreen() {
  return (
    <p role="status" data-screen="deconnecte">
      {messages.signedOut}
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
  const [code, setCode] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit(code);
  }

  return (
    <form data-screen="connexion-2fa" method="post" onSubmit={submit} aria-labelledby="mfa-challenge-title">
      <h1 id="mfa-challenge-title">{messages.challengeTitle}</h1>
      <p>{messages.challengeIntro}</p>
      <Alert notice={notice} />
      <label htmlFor="mfa-totp">{messages.totpLabel}</label>
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
        {pending ? messages.pending : messages.submitCode}
      </button>
      <button type="button" onClick={onUseRecovery} disabled={pending}>
        {messages.useRecovery}
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
  const [code, setCode] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit(code);
  }

  return (
    <form data-screen="connexion-code-secours" method="post" onSubmit={submit} aria-labelledby="mfa-recovery-title">
      <h1 id="mfa-recovery-title">{messages.recoveryTitle}</h1>
      <p>{messages.recoveryIntro}</p>
      <Alert notice={notice} />
      <label htmlFor="mfa-recovery">{messages.recoveryLabel}</label>
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
      <p id="mfa-recovery-hint">{messages.recoveryHint}</p>
      <button type="submit" disabled={pending}>
        {pending ? messages.pending : messages.submitRecovery}
      </button>
      <button type="button" onClick={onBack} disabled={pending}>
        {messages.backToTotp}
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
  const [code, setCode] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit(code);
  }

  return (
    <section data-screen="activation-2fa" aria-labelledby="mfa-activation-title">
      <h1 id="mfa-activation-title">{messages.activationTitle}</h1>
      <p>{messages.activationIntro}</p>
      <Alert notice={notice} />
      {secret !== null && otpauth !== null ? (
        <>
          <p id="mfa-secret-label">{messages.secretLabel}</p>
          <p data-field="totp-secret" aria-labelledby="mfa-secret-label">
            {groupSecret(secret)}
          </p>
          <a href={otpauth}>{messages.openApp}</a>
          <form method="post" onSubmit={submit}>
            <label htmlFor="mfa-enroll-code">{messages.totpLabel}</label>
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
              {pending ? messages.pending : messages.submitCode}
            </button>
          </form>
        </>
      ) : null}
      <button type="button" onClick={onSignOut} disabled={pending}>
        {messages.signOut}
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
  return (
    <section data-screen="codes-secours" aria-labelledby="mfa-codes-title">
      <h1 id="mfa-codes-title">{messages.codesTitle}</h1>
      <p>{messages.codesIntro}</p>
      <ol data-count={codes.length}>
        {codes.map((code, index) => (
          <li key={index}>{code}</li>
        ))}
      </ol>
      <button type="button" onClick={onCopy}>
        {messages.copy}
      </button>
      <button
        type="button"
        onClick={() => {
          saveCodes(codes);
        }}
      >
        {messages.save}
      </button>
      <button type="button" onClick={printCodes}>
        {messages.print}
      </button>
      {copyNotice === "copied" ? <p role="status">{messages.copied}</p> : null}
      {copyNotice === "failed" ? <p role="alert">{messages.copyFailed}</p> : null}
      <button type="button" onClick={onContinue}>
        {messages.continueTexts}
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
  return (
    <section data-screen="reconfigurer-2fa" aria-labelledby="mfa-reconfigure-title">
      <h1 id="mfa-reconfigure-title">{messages.reconfigureTitle}</h1>
      <p>{messages.reconfigureBody}</p>
      <Alert notice={notice} />
      <button type="button" onClick={onReconfigure} disabled={pending}>
        {pending ? messages.pending : messages.reconfigureNow}
      </button>
      <button type="button" onClick={onSignOut} disabled={pending}>
        {messages.signOut}
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
