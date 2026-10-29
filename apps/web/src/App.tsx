import { useState, type ReactNode } from "react";

import { AccountSettings } from "./auth-ui/account/index.ts";
import { AuthScreens, type AuthScreensProps } from "./auth-ui/index.ts";
import { MfaScreens, type MfaIntent, type MfaScreensProps } from "./auth-ui/mfa/index.ts";
import { Shell } from "./layout/Shell.tsx";
import { Library, LocalStoreProvider } from "./library/index.ts";

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

  const body = (
    <>
      {children ?? (
        <LocalStoreProvider>
          <Library />
        </LocalStoreProvider>
      )}
      <AccountSettings
        client={client}
        onChangeDevice={() => {
          setMfa({ intent: "reconfigure" });
        }}
        onRegenerateCodes={() => {
          setMfa({ intent: "reconfigure" });
        }}
      />
    </>
  );

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
