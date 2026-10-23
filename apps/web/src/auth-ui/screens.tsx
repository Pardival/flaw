import { useState, type FormEvent, type ReactNode } from "react";

import { useTranslate } from "../i18n/i18n.ts";
import type { Credentials, PasswordChange } from "./api.ts";
import type { Notice } from "./phase.ts";
import { IDENTIFIER_MAX_LENGTH, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, codePointLength } from "./policy.ts";

function alertMessage(notice: Notice, phrase: (key: string) => string): string | null {
  switch (notice) {
    case null:
      return null;
    case "credential":
      return phrase("credentialError");
    case "limited":
      return phrase("tooMany");
    case "rejected":
      return phrase("passwordRejected");
    case "invalid":
      return phrase("invalidRequest");
    case "network":
      return phrase("network");
    case "mfa":
      return phrase("mfaRequired");
    case "current":
      return phrase("currentPasswordWrong");
  }
}

function Alert({ notice }: { notice: Notice }) {
  const t = useTranslate("auth");
  const text = alertMessage(notice, t);
  if (text === null) {
    return null;
  }
  return <p role="alert">{text}</p>;
}

function ForgotExplanation() {
  const t = useTranslate("auth");
  return (
    <section aria-labelledby="auth-forgot-title">
      <h2 id="auth-forgot-title">{t("forgotTitle")}</h2>
      <p>{t("forgotBody")}</p>
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
  const t = useTranslate("auth");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const reconnect = variant === "reconnexion-necessaire";
  const emailId = reconnect ? "auth-reconnect-email" : "auth-email";
  const passwordId = reconnect ? "auth-reconnect-password" : "auth-password";
  const rememberId = reconnect ? "auth-reconnect-remember" : "auth-remember";
  const titleId = reconnect ? "auth-reconnect-title" : "auth-connexion-title";
  const submitLabel = reconnect ? t("reconnectAction") : t("submitSignIn");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit({ identifier, password, remember });
  }

  return (
    <form data-screen={variant} method="post" onSubmit={submit} aria-labelledby={titleId}>
      <h1 id={titleId}>{reconnect ? t("reconnectTitle") : t("connexionTitle")}</h1>
      {reconnect ? <p>{t("reconnectBody")}</p> : null}
      <Alert notice={notice} />
      {variant === "connexion-mdp-oublie" || (reconnect && forgot) ? <ForgotExplanation /> : null}
      <label htmlFor={emailId}>{t("emailLabel")}</label>
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
      <label htmlFor={passwordId}>{t("passwordLabel")}</label>
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
      <p>{t("passwordHint", { min: PASSWORD_MIN_LENGTH })}</p>
      <label htmlFor={rememberId}>{t("rememberLabel")}</label>
      <input
        id={rememberId}
        name="remember"
        type="checkbox"
        checked={remember}
        onChange={(event) => {
          setRemember(event.currentTarget.checked);
        }}
      />
      <p>{t("rememberHint")}</p>
      <button type="submit" disabled={pending}>
        {pending ? t("pending") : submitLabel}
      </button>
      {variant === "connexion-mdp-oublie" ? (
        <button type="button" onClick={onBack}>
          {t("backToSignIn")}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => {
            onForgot(identifier);
          }}
        >
          {t("forgotAction")}
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
  const t = useTranslate("auth");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState(initialNewPassword);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit({ currentPassword, newPassword });
  }

  return (
    <form data-screen="nouveau-mot-de-passe" method="post" onSubmit={submit} aria-labelledby="auth-new-title">
      <h1 id="auth-new-title">{t("newPasswordTitle")}</h1>
      <p>{t("newPasswordIntro")}</p>
      <label htmlFor="auth-current-password">{t("currentPasswordLabel")}</label>
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
      <label htmlFor="auth-new-password">{t("newPasswordLabel")}</label>
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
      <p id="auth-password-counter">
        {t("passwordCounter", { current: codePointLength(newPassword), min: PASSWORD_MIN_LENGTH })}
      </p>
      <Alert notice={notice} />
      <button type="submit" disabled={pending}>
        {pending ? t("pending") : t("submitChange")}
      </button>
    </form>
  );
}

export function LoadingScreen() {
  const t = useTranslate("auth");
  return (
    <p role="status" data-screen="loading">
      {t("loading")}
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
