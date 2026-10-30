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
import { de } from "./de.ts";
import { es } from "./es.ts";
import { it } from "./it.ts";
import { pt } from "./pt.ts";

export const defaultLanguage = "fr";

/** Langues de l'interface. `auto` suit le système (français si la langue du système l'est). */
export const UI_LANGUAGES = ["fr", "en", "es", "de", "it", "pt"] as const;
export type UiLanguage = (typeof UI_LANGUAGES)[number];
export type UiLanguageChoice = UiLanguage | "auto";
const UI_LANGUAGE_KEY = "flaw.uiLanguage";
const UI_LANGUAGE_CHOSEN_KEY = "flaw.uiLanguageChosen";

/** Faux tant que la personne n'a pas choisi sa langue au premier lancement. */
export function uiLanguageChosen(): boolean {
  try {
    return window.localStorage.getItem(UI_LANGUAGE_CHOSEN_KEY) === "true";
  } catch {
    return true;
  }
}

export function markUiLanguageChosen(): void {
  try {
    window.localStorage.setItem(UI_LANGUAGE_CHOSEN_KEY, "true");
  } catch {
    // Rien : l'écran reviendra au prochain lancement.
  }
}

export function readUiLanguageChoice(): UiLanguageChoice {
  try {
    const stored = window.localStorage.getItem(UI_LANGUAGE_KEY);
    if (stored !== null && (UI_LANGUAGES as readonly string[]).includes(stored)) return stored as UiLanguage;
  } catch {
    // Stockage indisponible : langue du système.
  }
  return "auto";
}

function systemLanguage(): UiLanguage {
  if (typeof navigator === "undefined") return defaultLanguage;
  for (const preferred of navigator.languages ?? [navigator.language]) {
    const code = (preferred ?? "").slice(0, 2).toLowerCase();
    if ((UI_LANGUAGES as readonly string[]).includes(code)) return code as UiLanguage;
  }
  return "en";
}

export function resolveUiLanguage(choice: UiLanguageChoice): UiLanguage {
  return choice === "auto" ? systemLanguage() : choice;
}

/** Locale des dates et nombres de l'interface. */
export function uiLocale(): string {
  const locales: Record<string, string> = { fr: "fr-FR", en: "en-US", es: "es-ES", de: "de-DE", it: "it-IT", pt: "pt-BR" };
  return locales[i18n.language] ?? "fr-FR";
}

const namespaces = ["auth", "mfa", "account", "theme", "library", "editor", "sync", "settings", "export", "import", "cover"] as const;

export type CatalogNamespace = (typeof namespaces)[number];

type Vars = Record<string, string | number>;

if (!i18n.isInitialized) {
  void i18n.use(initReactI18next).init({
    lng: typeof window === "undefined" ? defaultLanguage : resolveUiLanguage(readUiLanguageChoice()),
    // Langues sans écrans de connexion traduits : anglais, puis français.
    fallbackLng: { fr: [], default: ["en", "fr"] },
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
      es,
      de,
      it,
      pt,
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
