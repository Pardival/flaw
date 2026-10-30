import { useState } from "react";

import { LANG_NAMES } from "../editor/meta.ts";
import { UI_LANGUAGES, markUiLanguageChosen, resolveUiLanguage, setUiLanguage, useTranslate, type UiLanguage } from "../i18n/i18n.ts";
import { Logo } from "../shell/Logo.tsx";

/**
 * Premier lancement : choix de la langue de l'interface. La langue du système est
 * proposée d'emblée ; chaque clic traduit l'écran tout de suite.
 */
export function LanguageWelcome({ onDone }: { onDone: () => void }) {
  const t = useTranslate("library");
  const [choice, setChoice] = useState<UiLanguage>(() => resolveUiLanguage("auto"));
  return (
    <div className="language-welcome">
      <Logo />
      <h1>{t("languageTitle")}</h1>
      <p className="language-welcome-lead">{t("languageLead")}</p>
      <div className="language-grid" role="radiogroup" aria-label={t("languageTitle")}>
        {UI_LANGUAGES.map((lang) => (
          <button
            key={lang}
            type="button"
            role="radio"
            aria-checked={choice === lang}
            lang={lang}
            onClick={() => {
              setChoice(lang);
              setUiLanguage(lang);
            }}
          >
            {LANG_NAMES[lang]}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="button-primary language-continue"
        onClick={() => {
          setUiLanguage(choice);
          markUiLanguageChosen();
          onDone();
        }}
      >
        {t("languageContinue")}
      </button>
    </div>
  );
}
