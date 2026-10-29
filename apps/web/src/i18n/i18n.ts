import i18n from "i18next";
import { initReactI18next, useTranslation } from "react-i18next";

import { account } from "./fr/account.ts";
import { auth } from "./fr/auth.ts";
import { editor } from "./fr/editor.ts";
import { library } from "./fr/library.ts";
import { mfa } from "./fr/mfa.ts";
import { theme } from "./fr/theme.ts";

export const defaultLanguage = "fr";

const namespaces = ["auth", "mfa", "account", "theme", "library", "editor"] as const;

export type CatalogNamespace = (typeof namespaces)[number];

type Vars = Record<string, string | number>;

if (!i18n.isInitialized) {
  void i18n.use(initReactI18next).init({
    lng: defaultLanguage,
    fallbackLng: defaultLanguage,
    supportedLngs: [defaultLanguage],
    defaultNS: "auth",
    ns: [...namespaces],
    resources: {
      fr: { auth, mfa, account, theme, library, editor },
    },
    interpolation: { escapeValue: false },
    initAsync: false,
    returnNull: false,
    react: { useSuspense: false },
  });
}

function asText(value: unknown, key: string): string {
  return typeof value === "string" ? value : key;
}

/** Traduction hors React. La clé inclut l'espace de noms : `auth:emailLabel`. */
export function t(key: string, options?: Vars): string {
  const value = options === undefined ? i18n.t(key) : i18n.t(key, options);
  return asText(value, key);
}

/** Traduction React. `t("emailLabel")` lit l'espace de noms demandé, en français. */
export function useTranslate(ns: CatalogNamespace): (key: string, options?: Vars) => string {
  const { t: translate } = useTranslation(ns);
  return (key, options) => asText(options === undefined ? translate(key) : translate(key, options), key);
}

export default i18n;
