import { useEffect, useRef, useState } from "react";

import { createAuthClient, type AuthClient } from "../api.ts";
import {
  disconnectDevice,
  disconnectOthers,
  initialAccountState,
  loadAccount,
  reauthAndDisconnectOthers,
  reduceAccount,
  savePassword,
  type AccountAction,
  type AccountSession,
} from "./account.ts";
import { AccountSettingsScreen, type ReauthDraft } from "./screen.tsx";

export type AccountSettingsProps = {
  client?: AuthClient;
  onChangeDevice?: () => void;
  onRegenerateCodes?: () => void;
};

export function AccountSettings({ client, onChangeDevice, onRegenerateCodes }: AccountSettingsProps) {
  const owned = useRef<AuthClient | null>(null);
  const api = client ?? (owned.current ??= createAuthClient());
  const [state, setState] = useState(initialAccountState);
  const email = useRef("");
  const sessions = useRef<readonly AccountSession[]>([]);
  const alive = useRef(true);
  const busy = useRef(false);
  sessions.current = state.sessions;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadAccount(api).then((result) => {
      if (cancelled || !alive.current) {
        return;
      }
      email.current = result.profile?.email ?? "";
      setState((current) =>
        reduceAccount(current, {
          type: "loaded",
          blocked: result.profile === null,
          mfaEnrolled: result.profile?.mfaEnrolled ?? false,
          timeZone: result.profile?.timeZone ?? "UTC",
          sessions: result.sessions,
          notice: result.notice,
        }),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  function settle(action: AccountAction) {
    if (!alive.current) {
      return;
    }
    setState((current) => reduceAccount(current, action));
  }

  async function run(work: () => Promise<AccountAction>) {
    if (busy.current) {
      return;
    }
    busy.current = true;
    setState((current) => reduceAccount(current, { type: "pending" }));
    try {
      settle(await work());
    } catch {
      settle({ type: "notice", notice: "network" });
    } finally {
      busy.current = false;
    }
  }

  return (
    <AccountSettingsScreen
      phase={state.phase}
      pending={state.pending}
      mfaEnrolled={state.mfaEnrolled}
      timeZone={state.timeZone}
      sessions={state.sessions}
      sessionsKnown={state.sessionsKnown}
      notice={state.notice}
      reauth={state.reauth}
      onChangePassword={(value) => {
        void run(async () => {
          const result = await savePassword(api, value);
          if (!result.ok) {
            return { type: "notice", notice: result.kind };
          }
          return { type: "sessions", sessions: result.sessions, notice: "password_saved" };
        });
      }}
      onRevoke={(sessionId) => {
        const session = sessions.current.find((item) => item.id === sessionId);
        if (session === undefined || session.current) {
          return;
        }
        void run(async () => {
          const result = await disconnectDevice(api, session);
          if (!result.ok) {
            if (result.sessions !== undefined) {
              return { type: "sessions", sessions: result.sessions, notice: result.kind };
            }
            return { type: "notice", notice: result.kind };
          }
          if (result.signedOut) {
            return { type: "signed_out" };
          }
          return { type: "sessions", sessions: result.sessions, notice: "revoked" };
        });
      }}
      onSignOut={() => {
        const session = sessions.current.find((item) => item.current);
        if (session === undefined) {
          return;
        }
        void run(async () => {
          const result = await disconnectDevice(api, session);
          if (!result.ok) {
            return { type: "notice", notice: result.kind };
          }
          return { type: "signed_out" };
        });
      }}
      onRevokeOthers={() => {
        void run(async () => {
          const result = await disconnectOthers(api);
          if (!result.ok) {
            return result.kind === "reauth" ? { type: "need_reauth" } : { type: "notice", notice: result.kind };
          }
          return { type: "sessions", sessions: result.sessions, notice: "others_revoked" };
        });
      }}
      onReauth={(value: ReauthDraft) => {
        void run(async () => {
          const result = await reauthAndDisconnectOthers(api, {
            identifier: email.current,
            password: value.password,
            totp: value.totp,
            totpRequired: state.mfaEnrolled,
            remember: value.remember,
          });
          if (!result.ok) {
            return result.kind === "reauth"
              ? { type: "need_reauth" }
              : { type: "notice", notice: result.kind, reauth: true };
          }
          return { type: "sessions", sessions: result.sessions, notice: "others_revoked" };
        });
      }}
      onChangeDevice={() => {
        onChangeDevice?.();
      }}
      onRegenerateCodes={() => {
        onRegenerateCodes?.();
      }}
    />
  );
}
