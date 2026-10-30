import { useState, type ReactNode } from "react";

import { AccountSettings } from "./auth-ui/account/index.ts";
import { AuthScreens, type AuthScreensProps } from "./auth-ui/index.ts";
import { MfaScreens, type MfaIntent, type MfaScreensProps } from "./auth-ui/mfa/index.ts";
import { Shell } from "./layout/Shell.tsx";
import { Library, LocalStoreProvider } from "./library/index.ts";
import { LOCAL_ONLY } from "./platform/target.ts";
import { PreferencesProvider } from "./settings/preferences.tsx";
import { AccountSlot } from "./settings/SettingsPanel.tsx";

type MfaMount = {
  intent: MfaIntent;
  initialPhase?: MfaScreensProps["initialPhase"];
};

export type AppProps = {
  initialPhase?: AuthScreensProps["initialPhase"];
  initialMfa?: MfaScreensProps["initialPhase"];
  mfaIntent?: MfaIntent;
  client?: AuthScreensProps["client"];
  children?: ReactNode;
};

export function App({
  initialPhase,
  initialMfa,
  mfaIntent = "challenge",
  client,
  children,
}: AppProps = {}) {
  const [mfa, setMfa] = useState<MfaMount | null>(
    initialMfa !== undefined ? { intent: mfaIntent, initialPhase: initialMfa } : null,
  );

  const account = (
    <AccountSettings
      client={client}
      onChangeDevice={() => {
        setMfa({ intent: "reconfigure" });
      }}
      onRegenerateCodes={() => {
        setMfa({ intent: "reconfigure" });
      }}
    />
  );

  // Le compte s'affiche dans Réglages › Compte (P7).
  const body = (
    <AccountSlot.Provider value={account}>
      {children ?? (
        <PreferencesProvider>
          <LocalStoreProvider>
            <Library />
          </LocalStoreProvider>
        </PreferencesProvider>
      )}
    </AccountSlot.Provider>
  );

  if (LOCAL_ONLY) {
    // Version de bureau : ni compte, ni connexion ; la bibliothèque s'ouvre directement.
    return (
      <Shell>
        {children ?? (
          <PreferencesProvider>
            <LocalStoreProvider>
              <Library />
            </LocalStoreProvider>
          </PreferencesProvider>
        )}
      </Shell>
    );
  }

  return (
    <Shell>
      {mfa === null ? (
        <AuthScreens
          initialPhase={initialPhase}
          client={client}
          onMfaRequired={() => {
            setMfa({ intent: "challenge" });
          }}
        >
          {body}
        </AuthScreens>
      ) : (
        <MfaScreens
          client={client}
          intent={mfa.intent}
          initialPhase={mfa.initialPhase}
          onSignedOut={() => {
            setMfa(null);
          }}
        >
          {body}
        </MfaScreens>
      )}
    </Shell>
  );
}
