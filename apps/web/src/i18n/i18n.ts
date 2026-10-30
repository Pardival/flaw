import i18n from "i18next";
import { initReactI18next, useTranslation } from "react-i18next";

import { account } from "./fr/account.ts";
import { auth } from "./fr/auth.ts";
import { cover } from "./fr/cover.ts";
import { editor } from "./fr/editor.ts";
import { library } from "./fr/library.ts";
import { mfa } from "./fr/mfa.ts";
import { exportCatalog } from "./fr/export.ts";
import { importCatalog } from "./fr/import.ts";
import { settings } from "./fr/settings.ts";
import { sync } from "./fr/sync.ts";
import { theme } from "./fr/theme.ts";
import { account as accountEn } from "./en/account.ts";
import { auth as authEn } from "./en/auth.ts";
import { cover as coverEn } from "./en/cover.ts";
import { editor as editorEn } from "./en/editor.ts";
import { exportCatalog as exportEn } from "./en/export.ts";
import { importCatalog as importEn } from "./en/import.ts";
import { library as libraryEn } from "./en/library.ts";
import { mfa as mfaEn } from "./en/mfa.ts";
import { settings as settingsEn } from "./en/settings.ts";
import { sync as syncEn } from "./en/sync.ts";
import { theme as themeEn } from "./en/theme.ts";

export const defaultLanguage = "fr";

/** Langues de l'interface. `auto` suit le système (français si la langue du système l'est). */
export const UI_LANGUAGES = ["fr", "en"] as const;
export type UiLanguage = (typeof UI_LANGUAGES)[number];
export type UiLanguageChoice = UiLanguage | "auto";
const UI_LANGUAGE_KEY = "flaw.uiLanguage";

export function readUiLanguageChoice(): UiLanguageChoice {
  try {
    const stored = window.localStorage.getItem(UI_LANGUAGE_KEY);
    if (stored === "fr" || stored === "en") return stored;
  } catch {
    // Stockage indisponible : langue du système.
  }
  return "auto";
}

function systemLanguage(): UiLanguage {
  if (typeof navigator === "undefined") return defaultLanguage;
  const preferred = navigator.languages?.[0] ?? navigator.language ?? defaultLanguage;
  return preferred.toLowerCase().startsWith("fr") ? "fr" : "en";
}

export function resolveUiLanguage(choice: UiLanguageChoice): UiLanguage {
  return choice === "auto" ? systemLanguage() : choice;
}

/** Locale des dates et nombres de l'interface. */
export function uiLocale(): string {
  return i18n.language === "en" ? "en-US" : "fr-FR";
}

const namespaces = ["auth", "mfa", "account", "theme", "library", "editor", "sync", "settings", "export", "import", "cover"] as const;

export type CatalogNamespace = (typeof namespaces)[number];

type Vars = Record<string, string | number>;

if (!i18n.isInitialized) {
  void i18n.use(initReactI18next).init({
    lng: typeof window === "undefined" ? defaultLanguage : resolveUiLanguage(readUiLanguageChoice()),
    fallbackLng: defaultLanguage,
    supportedLngs: [...UI_LANGUAGES],
    defaultNS: "auth",
    ns: [...namespaces],
    resources: {
      fr: { auth, mfa, account, theme, library, editor, sync, settings, export: exportCatalog, import: importCatalog, cover },
      en: {
        auth: authEn,
        mfa: mfaEn,
        account: accountEn,
        theme: themeEn,
        library: libraryEn,
        editor: editorEn,
        sync: syncEn,
        settings: settingsEn,
        export: exportEn,
        import: importEn,
        cover: coverEn,
      },
    },
    interpolation: { escapeValue: false },
    initAsync: false,
    returnNull: false,
    react: { useSuspense: false },
  });
}

/** Change la langue de l'interface tout de suite et la retient. */
export function setUiLanguage(choice: UiLanguageChoice): void {
  try {
    if (choice === "auto") window.localStorage.removeItem(UI_LANGUAGE_KEY);
    else window.localStorage.setItem(UI_LANGUAGE_KEY, choice);
  } catch {
    // Rien : la langue vaut pour cette session.
  }
  void i18n.changeLanguage(resolveUiLanguage(choice));
}

if (typeof document !== "undefined") {
  document.documentElement.lang = i18n.language;
  i18n.on("languageChanged", (language) => {
    document.documentElement.lang = language;
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
