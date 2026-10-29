import { useEffect } from "react";

import { useTranslate } from "../i18n/i18n.ts";
import { usePreferences } from "../settings/preferences.tsx";
import { refreshDaily, useDaily } from "./daily.ts";

/** Progression discrète de l'objectif du jour (AC-055), masquable dans Réglages. */
export function DailyGoal() {
  const t = useTranslate("editor");
  const { prefs } = usePreferences();
  const { words } = useDaily();
  useEffect(() => {
    void refreshDaily();
  }, []);
  if (!prefs.showDailyGoal || prefs.dailyWordGoal <= 0) {
    return null;
  }
  const ratio = Math.min(1, words / prefs.dailyWordGoal);
  return (
    <span className="daily-goal" title={t("dailyGoal")}>
      {t("today", { words, goal: prefs.dailyWordGoal })}
      <span className="daily-bar" aria-hidden="true">
        <span style={{ width: `${String(Math.round(ratio * 100))}%` }} />
      </span>
    </span>
  );
}
