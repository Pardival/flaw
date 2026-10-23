import { useState, type FormEvent, type ReactNode } from "react";

import type { Credentials, PasswordChange } from "./api.ts";
import { messages } from "./messages.fr.ts";
import type { Notice } from "./phase.ts";
import { IDENTIFIER_MAX_LENGTH, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, codePointLength } from "./policy.ts";

function alertMessage(notice: Notice): string | null {
  switch (notice) {
    case null:
      return null;
    case "credential":
      return messages.credentialError;
    case "limited":
      return messages.tooMany;
    case "rejected":
      return messages.passwordRejected;
    case "invalid":
      return messages.invalidRequest;
    case "network":
      return messages.network;
    case "mfa":
      return messages.mfaRequired;
    case "current":
      return messages.currentPasswordWrong;
  }
}

function Alert({ notice }: { notice: Notice }) {
  const text = alertMessage(notice);
  if (text === null) {
    return null;
  }
  return <p role="alert">{text}</p>;
}

function ForgotExplanation() {
  return (
    <section aria-labelledby="auth-forgot-title">
      <h2 id="auth-forgot-title">{messages.forgotTitle}</h2>
      <p>{messages.forgotBody}</p>
    </section>
  );
}

export function CredentialsScreen({
  variant,
  notice,
  pending,
  forgot,
  onSubmit,
  onForgot,
  onBack,
}: {
  variant: "connexion" | "connexion-mdp-oublie" | "reconnexion-necessaire";
  notice: Notice;
  pending: boolean;
  forgot: boolean;
  onSubmit: (value: Credentials) => void;
  onForgot: (identifier: string) => void;
  onBack: () => void;
}) {
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const reconnect = variant === "reconnexion-necessaire";
  const emailId = reconnect ? "auth-reconnect-email" : "auth-email";
  const passwordId = reconnect ? "auth-reconnect-password" : "auth-password";
  const rememberId = reconnect ? "auth-reconnect-remember" : "auth-remember";
  const titleId = reconnect ? "auth-reconnect-title" : "auth-connexion-title";
  const submitLabel = reconnect ? messages.reconnectAction : messages.submitSignIn;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit({ identifier, password, remember });
  }

  return (
    <form data-screen={variant} method="post" onSubmit={submit} aria-labelledby={titleId}>
      <h1 id={titleId}>{reconnect ? messages.reconnectTitle : messages.connexionTitle}</h1>
      {reconnect ? <p>{messages.reconnectBody}</p> : null}
      <Alert notice={notice} />
      {variant === "connexion-mdp-oublie" || (reconnect && forgot) ? <ForgotExplanation /> : null}
      <label htmlFor={emailId}>{messages.emailLabel}</label>
      <input
        id={emailId}
        name="identifier"
        type="email"
        autoComplete="username"
        autoCapitalize="none"
        required
        maxLength={IDENTIFIER_MAX_LENGTH}
        value={identifier}
        onChange={(event) => {
          setIdentifier(event.currentTarget.value);
        }}
      />
      <label htmlFor={passwordId}>{messages.passwordLabel}</label>
      <input
        id={passwordId}
        name="password"
        type="password"
        autoComplete="current-password"
        required
        maxLength={PASSWORD_MAX_LENGTH}
        value={password}
        onChange={(event) => {
          setPassword(event.currentTarget.value);
        }}
      />
      <p>{messages.passwordHint(PASSWORD_MIN_LENGTH)}</p>
      <label htmlFor={rememberId}>{messages.rememberLabel}</label>
      <input
        id={rememberId}
        name="remember"
        type="checkbox"
        checked={remember}
        onChange={(event) => {
          setRemember(event.currentTarget.checked);
        }}
      />
      <p>{messages.rememberHint}</p>
      <button type="submit" disabled={pending}>
        {pending ? messages.pending : submitLabel}
      </button>
      {variant === "connexion-mdp-oublie" ? (
        <button type="button" onClick={onBack}>
          {messages.backToSignIn}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => {
            onForgot(identifier);
          }}
        >
          {messages.forgotAction}
        </button>
      )}
    </form>
  );
}

export function NouveauMotDePasseScreen({
  notice,
  pending,
  initialNewPassword = "",
  onSubmit,
}: {
  notice: Notice;
  pending: boolean;
  initialNewPassword?: string;
  onSubmit: (value: PasswordChange) => void;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState(initialNewPassword);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit({ currentPassword, newPassword });
  }

  return (
    <form data-screen="nouveau-mot-de-passe" method="post" onSubmit={submit} aria-labelledby="auth-new-title">
      <h1 id="auth-new-title">{messages.newPasswordTitle}</h1>
      <p>{messages.newPasswordIntro}</p>
      <label htmlFor="auth-current-password">{messages.currentPasswordLabel}</label>
      <input
        id="auth-current-password"
        name="currentPassword"
        type="password"
        autoComplete="current-password"
        required
        maxLength={PASSWORD_MAX_LENGTH}
        value={currentPassword}
        onChange={(event) => {
          setCurrentPassword(event.currentTarget.value);
        }}
      />
      <label htmlFor="auth-new-password">{messages.newPasswordLabel}</label>
      <input
        id="auth-new-password"
        name="newPassword"
        type="password"
        autoComplete="new-password"
        required
        minLength={PASSWORD_MIN_LENGTH}
        maxLength={PASSWORD_MAX_LENGTH}
        value={newPassword}
        onChange={(event) => {
          setNewPassword(event.currentTarget.value);
        }}
        aria-describedby="auth-password-counter"
      />
      <p id="auth-password-counter">{messages.passwordCounter(codePointLength(newPassword), PASSWORD_MIN_LENGTH)}</p>
      <Alert notice={notice} />
      <button type="submit" disabled={pending}>
        {pending ? messages.pending : messages.submitChange}
      </button>
    </form>
  );
}

export function LoadingScreen() {
  return (
    <p role="status" data-screen="loading">
      {messages.loading}
    </p>
  );
}

export function screenPanel(props: {
  phaseName: "connexion" | "connexion-mdp-oublie" | "nouveau-mot-de-passe" | "reconnexion-necessaire" | "loading";
  notice: Notice;
  pending: boolean;
  forgot: boolean;
  onSubmit: (value: Credentials) => void;
  onForgot: (identifier: string) => void;
  onBack: () => void;
  onChangePassword: (value: PasswordChange) => void;
}): ReactNode {
  switch (props.phaseName) {
    case "loading":
      return <LoadingScreen />;
    case "connexion":
    case "connexion-mdp-oublie":
    case "reconnexion-necessaire":
      return (
        <CredentialsScreen
          variant={props.phaseName}
          notice={props.notice}
          pending={props.pending}
          forgot={props.forgot}
          onSubmit={props.onSubmit}
          onForgot={props.onForgot}
          onBack={props.onBack}
        />
      );
    case "nouveau-mot-de-passe":
      return (
        <NouveauMotDePasseScreen notice={props.notice} pending={props.pending} onSubmit={props.onChangePassword} />
      );
  }
}
