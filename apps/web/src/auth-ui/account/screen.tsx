import { useState, type FormEvent } from "react";

import type { PasswordChange } from "../api.ts";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, codePointLength } from "../policy.ts";
import {
  sessionView,
  type AccountNotice,
  type AccountPhase,
  type AccountSession,
} from "./account.ts";
import { messages } from "./messages.fr.ts";

export type ReauthDraft = {
  password: string;
  totp: string;
  remember: boolean;
};

export type AccountSettingsScreenProps = {
  phase: AccountPhase;
  pending: boolean;
  mfaEnrolled: boolean;
  timeZone: string;
  sessions: readonly AccountSession[];
  sessionsKnown: boolean;
  notice: AccountNotice;
  reauth: boolean;
  initialNewPassword?: string;
  onChangePassword: (value: PasswordChange) => void;
  onRevoke: (sessionId: string) => void;
  onSignOut: () => void;
  onRevokeOthers: () => void;
  onReauth: (value: ReauthDraft) => void;
  onChangeDevice: () => void;
  onRegenerateCodes: () => void;
};

function alertMessage(notice: AccountNotice): string | null {
  switch (notice) {
    case null:
    case "reauth":
      return null;
    case "unauthorized":
      return messages.unauthorized;
    case "mfa":
      return messages.mfaRequired;
    case "not_found":
      return messages.notFound;
    case "forbidden":
      return messages.forbidden;
    case "network":
      return messages.network;
    case "server":
      return messages.server;
    case "rejected":
      return messages.passwordRejected;
    case "current_password":
      return messages.currentPasswordWrong;
    case "reauth_failed":
      return messages.reauthFailed;
    case "invalid":
      return messages.invalidRequest;
    case "limited":
      return messages.tooMany;
    case "password_saved":
      return messages.passwordSaved;
    case "revoked":
      return messages.revoked;
    case "others_revoked":
      return messages.othersRevoked;
    default: {
      const exhaustive: never = notice;
      return exhaustive;
    }
  }
}

function Alert({ notice }: { notice: AccountNotice }) {
  const text = alertMessage(notice);
  if (text === null) {
    return null;
  }
  const success = notice === "password_saved" || notice === "revoked" || notice === "others_revoked";
  return <p role={success ? "status" : "alert"}>{text}</p>;
}

function PasswordForm({
  pending,
  initialNewPassword,
  onChangePassword,
}: {
  pending: boolean;
  initialNewPassword: string;
  onChangePassword: (value: PasswordChange) => void;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState(initialNewPassword);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onChangePassword({ currentPassword, newPassword });
  }

  return (
    <form method="post" onSubmit={submit} aria-labelledby="account-password-title">
      <h2 id="account-password-title">{messages.passwordTitle}</h2>
      <label htmlFor="account-current-password">{messages.currentPasswordLabel}</label>
      <input
        id="account-current-password"
        name="currentPassword"
        type="password"
        autoComplete="current-password"
        required
        maxLength={PASSWORD_MAX_LENGTH}
        disabled={pending}
        value={currentPassword}
        onChange={(event) => {
          setCurrentPassword(event.currentTarget.value);
        }}
      />
      <label htmlFor="account-new-password">{messages.newPasswordLabel}</label>
      <input
        id="account-new-password"
        name="newPassword"
        type="password"
        autoComplete="new-password"
        required
        minLength={PASSWORD_MIN_LENGTH}
        maxLength={PASSWORD_MAX_LENGTH}
        disabled={pending}
        value={newPassword}
        onChange={(event) => {
          setNewPassword(event.currentTarget.value);
        }}
        aria-describedby="account-password-counter"
      />
      <p id="account-password-counter">{messages.passwordCounter(codePointLength(newPassword), PASSWORD_MIN_LENGTH)}</p>
      <p>{messages.passwordHint(PASSWORD_MIN_LENGTH)}</p>
      <button type="submit" disabled={pending}>
        {pending ? messages.pending : messages.submitPassword}
      </button>
    </form>
  );
}

function ReauthForm({
  pending,
  totpRequired,
  onReauth,
}: {
  pending: boolean;
  totpRequired: boolean;
  onReauth: (value: ReauthDraft) => void;
}) {
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [remember, setRemember] = useState(false);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onReauth({ password, totp, remember });
  }

  return (
    <form method="post" onSubmit={submit} aria-labelledby="account-reauth-title">
      <h3 id="account-reauth-title">{messages.reauthTitle}</h3>
      <p role="alert">{totpRequired ? messages.reauthBody : messages.reauthBodyPassword}</p>
      <label htmlFor="account-reauth-password">{messages.reauthPasswordLabel}</label>
      <input
        id="account-reauth-password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
        maxLength={PASSWORD_MAX_LENGTH}
        disabled={pending}
        value={password}
        onChange={(event) => {
          setPassword(event.currentTarget.value);
        }}
      />
      {totpRequired ? (
        <>
          <label htmlFor="account-reauth-totp">{messages.reauthTotpLabel}</label>
          <input
            id="account-reauth-totp"
            name="totp"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            minLength={6}
            maxLength={6}
            pattern="[0-9]{6}"
            disabled={pending}
            value={totp}
            onChange={(event) => {
              setTotp(event.currentTarget.value);
            }}
          />
        </>
      ) : null}
      <label htmlFor="account-reauth-remember">{messages.rememberLabel}</label>
      <input
        id="account-reauth-remember"
        name="remember"
        type="checkbox"
        disabled={pending}
        checked={remember}
        onChange={(event) => {
          setRemember(event.currentTarget.checked);
        }}
      />
      <p>{messages.rememberHint}</p>
      <button type="submit" disabled={pending}>
        {pending ? messages.pending : messages.submitReauth}
      </button>
    </form>
  );
}

function DeviceList({
  sessions,
  timeZone,
  pending,
  onRevoke,
  onSignOut,
}: {
  sessions: readonly AccountSession[];
  timeZone: string;
  pending: boolean;
  onRevoke: (sessionId: string) => void;
  onSignOut: () => void;
}) {
  return (
    <ul>
      {sessions.map((session) => {
        const view = sessionView(session, timeZone);
        return (
          <li key={view.id} data-session={view.id} data-current={view.current ? "true" : "false"}>
            <p>
              {messages.typeLabel} {view.typeLabel}
            </p>
            <p>
              {messages.browserLabel} {view.browser}
            </p>
            <p>
              {messages.osLabel} {view.os}
            </p>
            <p>
              {messages.activityLabel} {view.lastActivity}
            </p>
            {view.current ? (
              <>
                <p>{messages.thisDevice}</p>
                <button type="button" data-action="sign-out" disabled={pending} onClick={onSignOut}>
                  {messages.signOut}
                </button>
              </>
            ) : (
              <button
                type="button"
                data-action="revoke"
                disabled={pending}
                onClick={() => {
                  onRevoke(view.id);
                }}
              >
                {messages.revoke}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function AccountSettingsScreen({
  phase,
  pending,
  mfaEnrolled,
  timeZone,
  sessions,
  sessionsKnown,
  notice,
  reauth,
  initialNewPassword = "",
  onChangePassword,
  onRevoke,
  onSignOut,
  onRevokeOthers,
  onReauth,
  onChangeDevice,
  onRegenerateCodes,
}: AccountSettingsScreenProps) {
  if (phase === "loading") {
    return (
      <section data-screen="reglages-compte" aria-labelledby="account-title">
        <h1 id="account-title">{messages.title}</h1>
        <p role="status">{messages.loading}</p>
      </section>
    );
  }

  if (phase === "signed_out") {
    return (
      <section data-screen="reglages-compte" aria-labelledby="account-title">
        <h1 id="account-title">{messages.title}</h1>
        <p role="status">{messages.signedOut}</p>
      </section>
    );
  }

  if (phase === "blocked") {
    return (
      <section data-screen="reglages-compte" aria-labelledby="account-title">
        <h1 id="account-title">{messages.title}</h1>
        <Alert notice={notice} />
      </section>
    );
  }

  return (
    <section data-screen="reglages-compte" aria-labelledby="account-title">
      <h1 id="account-title">{messages.title}</h1>
      <Alert notice={notice} />
      <PasswordForm pending={pending} initialNewPassword={initialNewPassword} onChangePassword={onChangePassword} />
      <section aria-labelledby="account-mfa-title">
        <h2 id="account-mfa-title">{messages.mfaTitle}</h2>
        <p>{mfaEnrolled ? messages.mfaActive : messages.mfaObligatory}</p>
        {mfaEnrolled ? (
          <>
            <button type="button" data-action="change-device" disabled={pending} onClick={onChangeDevice}>
              {messages.changeDevice}
            </button>
            <button type="button" data-action="regenerate-codes" disabled={pending} onClick={onRegenerateCodes}>
              {messages.regenerateCodes}
            </button>
          </>
        ) : null}
      </section>
      <section aria-labelledby="account-devices-title">
        <h2 id="account-devices-title">{messages.devicesTitle}</h2>
        {sessionsKnown && sessions.length === 0 ? <p>{messages.emptyDevices}</p> : null}
        {sessions.length > 0 ? (
          <DeviceList
            sessions={sessions}
            timeZone={timeZone}
            pending={pending}
            onRevoke={onRevoke}
            onSignOut={onSignOut}
          />
        ) : null}
        <button type="button" data-action="revoke-others" disabled={pending} onClick={onRevokeOthers}>
          {messages.revokeOthers}
        </button>
        {reauth ? <ReauthForm pending={pending} totpRequired={mfaEnrolled} onReauth={onReauth} /> : null}
      </section>
    </section>
  );
}
