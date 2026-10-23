import { useState, type FormEvent } from "react";

import { useTranslate } from "../../i18n/i18n.ts";
import type { PasswordChange } from "../api.ts";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, codePointLength } from "../policy.ts";
import {
  sessionView,
  type AccountNotice,
  type AccountPhase,
  type AccountSession,
} from "./account.ts";

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

function alertMessage(notice: AccountNotice, phrase: (key: string) => string): string | null {
  switch (notice) {
    case null:
    case "reauth":
      return null;
    case "unauthorized":
      return phrase("unauthorized");
    case "mfa":
      return phrase("mfaRequired");
    case "not_found":
      return phrase("notFound");
    case "forbidden":
      return phrase("forbidden");
    case "network":
      return phrase("network");
    case "server":
      return phrase("server");
    case "rejected":
      return phrase("passwordRejected");
    case "current_password":
      return phrase("currentPasswordWrong");
    case "reauth_failed":
      return phrase("reauthFailed");
    case "invalid":
      return phrase("invalidRequest");
    case "limited":
      return phrase("tooMany");
    case "password_saved":
      return phrase("passwordSaved");
    case "revoked":
      return phrase("revoked");
    case "others_revoked":
      return phrase("othersRevoked");
    default: {
      const exhaustive: never = notice;
      return exhaustive;
    }
  }
}

function Alert({ notice }: { notice: AccountNotice }) {
  const t = useTranslate("account");
  const text = alertMessage(notice, t);
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
  const t = useTranslate("account");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState(initialNewPassword);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onChangePassword({ currentPassword, newPassword });
  }

  return (
    <form method="post" onSubmit={submit} aria-labelledby="account-password-title">
      <h2 id="account-password-title">{t("passwordTitle")}</h2>
      <label htmlFor="account-current-password">{t("currentPasswordLabel")}</label>
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
      <label htmlFor="account-new-password">{t("newPasswordLabel")}</label>
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
      <p id="account-password-counter">{t("passwordCounter", { current: codePointLength(newPassword), min: PASSWORD_MIN_LENGTH })}</p>
      <p>{t("passwordHint", { min: PASSWORD_MIN_LENGTH })}</p>
      <button type="submit" disabled={pending}>
        {pending ? t("pending") : t("submitPassword")}
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
  const t = useTranslate("account");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [remember, setRemember] = useState(false);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onReauth({ password, totp, remember });
  }

  return (
    <form method="post" onSubmit={submit} aria-labelledby="account-reauth-title">
      <h3 id="account-reauth-title">{t("reauthTitle")}</h3>
      <p role="alert">{totpRequired ? t("reauthBody") : t("reauthBodyPassword")}</p>
      <label htmlFor="account-reauth-password">{t("reauthPasswordLabel")}</label>
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
          <label htmlFor="account-reauth-totp">{t("reauthTotpLabel")}</label>
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
      <label htmlFor="account-reauth-remember">{t("rememberLabel")}</label>
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
      <p>{t("rememberHint")}</p>
      <button type="submit" disabled={pending}>
        {pending ? t("pending") : t("submitReauth")}
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
  const t = useTranslate("account");
  return (
    <ul>
      {sessions.map((session) => {
        const view = sessionView(session, timeZone);
        return (
          <li key={view.id} data-session={view.id} data-current={view.current ? "true" : "false"}>
            <p>
              {t("typeLabel")} {view.typeLabel}
            </p>
            <p>
              {t("browserLabel")} {view.browser}
            </p>
            <p>
              {t("osLabel")} {view.os}
            </p>
            <p>
              {t("activityLabel")} {view.lastActivity}
            </p>
            {view.current ? (
              <>
                <p>{t("thisDevice")}</p>
                <button type="button" data-action="sign-out" disabled={pending} onClick={onSignOut}>
                  {t("signOut")}
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
                {t("revoke")}
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
  const t = useTranslate("account");
  if (phase === "loading") {
    return (
      <section data-screen="reglages-compte" aria-labelledby="account-title">
        <h1 id="account-title">{t("title")}</h1>
        <p role="status">{t("loading")}</p>
      </section>
    );
  }

  if (phase === "signed_out") {
    return (
      <section data-screen="reglages-compte" aria-labelledby="account-title">
        <h1 id="account-title">{t("title")}</h1>
        <p role="status">{t("signedOut")}</p>
      </section>
    );
  }

  if (phase === "blocked") {
    return (
      <section data-screen="reglages-compte" aria-labelledby="account-title">
        <h1 id="account-title">{t("title")}</h1>
        <Alert notice={notice} />
      </section>
    );
  }

  return (
    <section data-screen="reglages-compte" aria-labelledby="account-title">
      <h1 id="account-title">{t("title")}</h1>
      <Alert notice={notice} />
      <PasswordForm pending={pending} initialNewPassword={initialNewPassword} onChangePassword={onChangePassword} />
      <section aria-labelledby="account-mfa-title">
        <h2 id="account-mfa-title">{t("mfaTitle")}</h2>
        <p>{mfaEnrolled ? t("mfaActive") : t("mfaObligatory")}</p>
        {mfaEnrolled ? (
          <>
            <button type="button" data-action="change-device" disabled={pending} onClick={onChangeDevice}>
              {t("changeDevice")}
            </button>
            <button type="button" data-action="regenerate-codes" disabled={pending} onClick={onRegenerateCodes}>
              {t("regenerateCodes")}
            </button>
          </>
        ) : null}
      </section>
      <section aria-labelledby="account-devices-title">
        <h2 id="account-devices-title">{t("devicesTitle")}</h2>
        {sessionsKnown && sessions.length === 0 ? <p>{t("emptyDevices")}</p> : null}
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
          {t("revokeOthers")}
        </button>
        {reauth ? <ReauthForm pending={pending} totpRequired={mfaEnrolled} onReauth={onReauth} /> : null}
      </section>
    </section>
  );
}
