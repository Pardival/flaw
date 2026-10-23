/** Thème clair / sombre. Sans attribut data-theme, le CSS suit prefers-color-scheme. */

export const THEME_STORAGE_KEY = "flaw.theme";

export type ThemeChoice = "auto" | "clair" | "sombre";
export type ResolvedTheme = "clair" | "sombre";

export type ThemeStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export type ThemeRoot = {
  dataset: {
    theme?: string;
  };
};

export function readChoice(storage: ThemeStorage | null): ThemeChoice {
  if (storage === null) {
    return "auto";
  }
  try {
    const value = storage.getItem(THEME_STORAGE_KEY);
    if (value === "clair" || value === "sombre") {
      return value;
    }
    return "auto";
  } catch {
    return "auto";
  }
}

export function writeChoice(storage: ThemeStorage, choice: ResolvedTheme): void {
  storage.setItem(THEME_STORAGE_KEY, choice);
}

export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): ResolvedTheme {
  if (choice === "clair" || choice === "sombre") {
    return choice;
  }
  return prefersDark ? "sombre" : "clair";
}

export function toggleTheme(choice: ThemeChoice, prefersDark: boolean): ResolvedTheme {
  return resolveTheme(choice, prefersDark) === "sombre" ? "clair" : "sombre";
}

export function applyThemeChoice(root: ThemeRoot, choice: ThemeChoice, prefersDark: boolean): ResolvedTheme {
  const resolved = resolveTheme(choice, prefersDark);
  if (choice === "auto") {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = resolved;
  }
  return resolved;
}

export function browserStorage(): ThemeStorage | null {
  try {
    if (typeof localStorage === "undefined") {
      return null;
    }
    return localStorage;
  } catch {
    return null;
  }
}

export function browserPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}
