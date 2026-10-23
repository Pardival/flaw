/** Thème clair / sombre : prefers-color-scheme, bascule manuelle persistée. */

export const THEME_STORAGE_KEY = "flaw.theme";

export type ThemeChoice = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

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
    return "system";
  }
  try {
    const value = storage.getItem(THEME_STORAGE_KEY);
    if (value === "light" || value === "dark") {
      return value;
    }
    return "system";
  } catch {
    return "system";
  }
}

export function writeChoice(storage: ThemeStorage, choice: ResolvedTheme): void {
  storage.setItem(THEME_STORAGE_KEY, choice);
}

export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): ResolvedTheme {
  if (choice === "light" || choice === "dark") {
    return choice;
  }
  return prefersDark ? "dark" : "light";
}

export function toggleTheme(choice: ThemeChoice, prefersDark: boolean): ResolvedTheme {
  return resolveTheme(choice, prefersDark) === "dark" ? "light" : "dark";
}

export function applyThemeChoice(root: ThemeRoot, choice: ThemeChoice, prefersDark: boolean): ResolvedTheme {
  const resolved = resolveTheme(choice, prefersDark);
  if (choice === "system") {
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
