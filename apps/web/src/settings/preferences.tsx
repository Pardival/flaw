import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { CSRF_HEADER, CSRF_VALUE } from "../auth-ui/api.ts";
import { applyThemeChoice, browserPrefersDark, browserStorage, THEME_STORAGE_KEY, type ThemeChoice } from "../theme/theme.ts";

/**
 * Préférences du compte (API-006/007) : dernier écrit gagne, contrôle par ETag.
 * Copie locale pour l'hors ligne (aucun jeton, SEC-CLI-01) ; envoi au retour du réseau.
 */
export type Preferences = {
  theme: "light" | "dark" | "system";
  dailyWordGoal: number;
  showWordCount: boolean;
  showDailyGoal: boolean;
  frenchTypographyDefault: boolean;
  defaultTextLang: string;
  spellcheck: boolean;
};

export const DEFAULT_PREFERENCES: Preferences = {
  theme: "system",
  dailyWordGoal: 500,
  showWordCount: true,
  showDailyGoal: true,
  frenchTypographyDefault: true,
  defaultTextLang: "fr",
  spellcheck: false,
};

const LOCAL_KEY = "flaw.preferences";
const PATH = "/api/v1/me/preferences";

function readLocal(): { prefs: Preferences; dirty: Partial<Preferences> } {
  try {
    const raw = window.localStorage.getItem(LOCAL_KEY);
    if (raw !== null) {
      const parsed = JSON.parse(raw) as { prefs?: Partial<Preferences>; dirty?: Partial<Preferences> };
      return { prefs: { ...DEFAULT_PREFERENCES, ...parsed.prefs }, dirty: parsed.dirty ?? {} };
    }
  } catch {
    // Stockage indisponible : valeurs par défaut.
  }
  return { prefs: DEFAULT_PREFERENCES, dirty: {} };
}

function writeLocal(prefs: Preferences, dirty: Partial<Preferences>): void {
  try {
    window.localStorage.setItem(LOCAL_KEY, JSON.stringify({ prefs, dirty }));
  } catch {
    // Rien : la préférence reste en mémoire.
  }
}

function themeChoice(theme: Preferences["theme"]): ThemeChoice {
  return theme === "light" ? "clair" : theme === "dark" ? "sombre" : "auto";
}

/** Applique le thème (AC-045) ; en automatique, suit le système. */
export function applyTheme(theme: Preferences["theme"]): void {
  const choice = themeChoice(theme);
  const storage = browserStorage();
  try {
    if (choice === "auto") {
      window.localStorage.removeItem(THEME_STORAGE_KEY);
    } else {
      storage?.setItem(THEME_STORAGE_KEY, choice);
    }
  } catch {
    // Rien.
  }
  applyThemeChoice(document.documentElement, choice, browserPrefersDark());
}

type Context = { prefs: Preferences; update: (patch: Partial<Preferences>) => void };

const PreferencesContext = createContext<Context>({ prefs: DEFAULT_PREFERENCES, update: () => undefined });

function pick(value: unknown): Partial<Preferences> {
  if (value === null || typeof value !== "object") {
    return {};
  }
  const record = value as Record<string, unknown>;
  const out: Partial<Preferences> = {};
  if (record.theme === "light" || record.theme === "dark" || record.theme === "system") out.theme = record.theme;
  if (typeof record.dailyWordGoal === "number") out.dailyWordGoal = record.dailyWordGoal;
  if (typeof record.showWordCount === "boolean") out.showWordCount = record.showWordCount;
  if (typeof record.showDailyGoal === "boolean") out.showDailyGoal = record.showDailyGoal;
  if (typeof record.frenchTypographyDefault === "boolean") out.frenchTypographyDefault = record.frenchTypographyDefault;
  if (typeof record.defaultTextLang === "string") out.defaultTextLang = record.defaultTextLang;
  if (typeof record.spellcheck === "boolean") out.spellcheck = record.spellcheck;
  return out;
}

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const initial = useRef(readLocal());
  const [prefs, setPrefs] = useState<Preferences>(initial.current.prefs);
  const dirty = useRef<Partial<Preferences>>(initial.current.dirty);
  const etag = useRef<string | null>(null);

  const push = useCallback(async (): Promise<void> => {
    const patch = dirty.current;
    if (Object.keys(patch).length === 0 || !navigator.onLine) {
      return;
    }
    const headers = new Headers({ "content-type": "application/json", [CSRF_HEADER]: CSRF_VALUE });
    if (etag.current !== null) {
      headers.set("if-match", etag.current);
    }
    let response = await fetch(PATH, { method: "PATCH", headers, body: JSON.stringify(patch), credentials: "same-origin" });
    if (response.status === 412) {
      // Modifié ailleurs : on relit puis on réapplique (dernier écrit gagne).
      headers.delete("if-match");
      response = await fetch(PATH, { method: "PATCH", headers, body: JSON.stringify(patch), credentials: "same-origin" });
    }
    if (response.ok) {
      etag.current = response.headers.get("etag");
      dirty.current = {};
      const merged = { ...DEFAULT_PREFERENCES, ...pick(await response.json()) };
      setPrefs(merged);
      writeLocal(merged, {});
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const pull = async () => {
      try {
        const response = await fetch(PATH, { credentials: "same-origin" });
        if (!response.ok || !alive) {
          return;
        }
        etag.current = response.headers.get("etag");
        const merged = { ...DEFAULT_PREFERENCES, ...pick(await response.json()), ...dirty.current };
        setPrefs(merged);
        writeLocal(merged, dirty.current);
        await push();
      } catch {
        // Hors ligne : copie locale.
      }
    };
    void pull();
    const onOnline = () => {
      void pull();
    };
    window.addEventListener("online", onOnline);
    return () => {
      alive = false;
      window.removeEventListener("online", onOnline);
    };
  }, [push]);

  useEffect(() => {
    applyTheme(prefs.theme);
    if (prefs.theme !== "system") {
      return;
    }
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      applyTheme("system");
    };
    media.addEventListener("change", onChange);
    return () => {
      media.removeEventListener("change", onChange);
    };
  }, [prefs.theme]);

  const update = useCallback(
    (patch: Partial<Preferences>) => {
      setPrefs((previous) => {
        const next = { ...previous, ...patch };
        dirty.current = { ...dirty.current, ...patch };
        writeLocal(next, dirty.current);
        return next;
      });
      void push().catch(() => undefined);
    },
    [push],
  );

  return <PreferencesContext.Provider value={{ prefs, update }}>{children}</PreferencesContext.Provider>;
}

export function usePreferences(): Context {
  return useContext(PreferencesContext);
}
