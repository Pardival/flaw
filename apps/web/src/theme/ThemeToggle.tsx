import { useEffect, useState } from "react";

import { messages } from "./messages.fr.ts";
import {
  applyThemeChoice,
  browserPrefersDark,
  browserStorage,
  readChoice,
  resolveTheme,
  toggleTheme,
  writeChoice,
  type ThemeChoice,
} from "./theme.ts";

export function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>(() => readChoice(browserStorage()));
  const [prefersDark, setPrefersDark] = useState(browserPrefersDark);
  const resolved = resolveTheme(choice, prefersDark);
  const next = toggleTheme(choice, prefersDark);
  const label = next === "sombre" ? messages.themeToDark : messages.themeToLight;

  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return undefined;
    }
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    function onChange(): void {
      setPrefersDark(media.matches);
      const stored = readChoice(browserStorage());
      if (stored === "auto") {
        applyThemeChoice(document.documentElement, "auto", media.matches);
      }
    }
    media.addEventListener("change", onChange);
    return () => {
      media.removeEventListener("change", onChange);
    };
  }, []);

  function onClick(): void {
    const storage = browserStorage();
    const currentPrefers = browserPrefersDark();
    const chosen = toggleTheme(readChoice(storage), currentPrefers);
    if (storage !== null) {
      try {
        writeChoice(storage, chosen);
      } catch {
        /* la bascule reste visible pour cette page */
      }
    }
    applyThemeChoice(document.documentElement, chosen, currentPrefers);
    setPrefersDark(currentPrefers);
    setChoice(chosen);
  }

  return (
    <button type="button" className="theme-toggle" onClick={onClick} aria-pressed={resolved === "sombre"}>
      {label}
    </button>
  );
}
