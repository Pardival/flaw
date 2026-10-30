import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { useTranslate } from "../i18n/i18n.ts";
import type { DocumentMode, LocalDocument, PageFormat } from "../local-store/index.ts";
import { DOCUMENT_MODES } from "../local-store/index.ts";
import { FORMATS_BY_MODE, defaultFormat, formatDimensions } from "../library/formats-by-mode.ts";
import { pageSize } from "../layout/formats.ts";
import { tokens } from "../theme/tokens.ts";
import { usePreferences, type Preferences } from "./preferences.tsx";
import { CSRF_HEADER, CSRF_VALUE } from "../auth-ui/api.ts";
import { download } from "../export/run.ts";
import { BackupError, exportLibrary, importLibrary } from "../library/backup.ts";
import { useLocalStore } from "../library/store-context.tsx";
import { saveFile } from "../platform/files.ts";
import { LOCAL_ONLY } from "../platform/target.ts";
import { useClosing } from "../shell/presence.ts";

/** Écran Compte existant (T-014b), fourni par l'App pour l'onglet Compte. */
export const AccountSlot = createContext<ReactNode>(null);

type Usage = "roman" | "script" | "document" | "page-blanche";
const USAGE: Record<DocumentMode, Usage> = { novel: "roman", screenplay: "script", document: "document", blank: "page-blanche" };

/** Polices du § 5.5 par mode, défaut en tête (AC-006, AC-007) ; script : imposée (AC-008). */
export function fontsFor(mode: DocumentMode): string[] {
  const usage = tokens.typographie["polices-par-usage"][USAGE[mode]] as { defaut: string; alternatives: string[] };
  return [usage.defaut, ...usage.alternatives];
}

export type TextSettings = {
  document: LocalDocument;
  lang: "fr" | "en";
  frenchTypography: boolean | null;
  fontFamily: string;
  baseFontSizePt: number;
  onRename: (title: string) => void;
  onFormat: (format: PageFormat) => void;
  onFont: (font: string) => void;
  onSize: (size: number) => void;
  onLang: (lang: "fr" | "en") => void;
  onFrenchTypography: (value: boolean | null) => void;
  onMode: (mode: DocumentMode) => void;
};

type Tab = "text" | "general" | "account";

/** Panneau Réglages (P7, D-051, D-052) : latéral non modal sur ordinateur, feuille sur téléphone. */
export function SettingsPanel({ text, onClose: closeNow, onTrash }: { text?: TextSettings; onClose: () => void; onTrash?: () => void }) {
  const t = useTranslate("settings");
  const [tab, setTab] = useState<Tab>(text ? "text" : "general");
  const { closing, close: onClose } = useClosing(closeNow);
  const account = useContext(AccountSlot);
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    panel.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <aside ref={panel} className={`settings-panel${closing ? " is-closing" : ""}`} tabIndex={-1} aria-label={t("title")}>
      <header className="settings-head">
        <div role="tablist" className="settings-tabs">
          {text ? (
            <button type="button" role="tab" aria-selected={tab === "text"} onClick={() => setTab("text")}>
              {t("tabText")}
            </button>
          ) : null}
          <button type="button" role="tab" aria-selected={tab === "general"} onClick={() => setTab("general")}>
            {t("tabGeneral")}
          </button>
          {LOCAL_ONLY ? null : (
            <button type="button" role="tab" aria-selected={tab === "account"} onClick={() => setTab("account")}>
              {t("tabAccount")}
            </button>
          )}
        </div>
        <button type="button" className="icon-button" aria-label={t("close")} onClick={onClose}>
          ×
        </button>
      </header>
      <div className="settings-body">
        {tab === "text" && text ? <TextTab text={text} /> : null}
        {tab === "general" ? <GeneralTab onTrash={onTrash} /> : null}
        {tab === "account" ? <div className="settings-account">{account}</div> : null}
      </div>
    </aside>
  );
}

function TextTab({ text }: { text: TextSettings }) {
  const t = useTranslate("settings");
  const { prefs } = usePreferences();
  const [title, setTitle] = useState(text.document.title);
  const [pendingMode, setPendingMode] = useState<DocumentMode | null>(null);
  const mode = text.document.mode;
  const fonts = fontsFor(mode);
  const french = text.frenchTypography ?? prefs.frenchTypographyDefault;

  return (
    <div className="settings-section">
      <section className="settings-group">
        <h3 className="settings-group-title">{t("groupText")}</h3>
      <label className="settings-field">
        <span>{mode === "novel" ? t("bookTitle") : t("textTitle")}</span>
        <input
          value={title}
          maxLength={300}
          onChange={(event) => {
            const value = event.currentTarget.value;
            setTitle(value);
            // Renommage au fil de la frappe ; un titre vide attend la sortie du champ.
            if (value.trim().length > 0 && value.trim() !== text.document.title) {
              text.onRename(value.trim());
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.currentTarget.blur();
            }
          }}
          onBlur={() => {
            const next = title.trim() || t("untitled");
            setTitle(next);
            if (next !== text.document.title) {
              text.onRename(next);
            }
          }}
        />
      </label>

      <fieldset className="settings-field">
        <legend>{t("mode")}</legend>
        <select
          value={mode}
          onChange={(event) => {
            const next = event.currentTarget.value as DocumentMode;
            if (next !== mode) {
              setPendingMode(next);
            }
          }}
        >
          {DOCUMENT_MODES.map((item) => (
            <option key={item} value={item}>
              {t(`mode_${item}`)}
            </option>
          ))}
        </select>
      </fieldset>
      </section>
      <section className="settings-group">
        <h3 className="settings-group-title">{t("groupPage")}</h3>
      <fieldset className="settings-field">
        <legend>{t("format")}</legend>
        <div className="settings-silhouettes" role="radiogroup" aria-label={t("format")}>
          {FORMATS_BY_MODE[mode].map((format) => {
            const { widthMm, heightMm } = pageSize(format);
            const scale = 80 / 297;
            return (
              <button
                key={format}
                type="button"
                role="radio"
                aria-checked={text.document.pageFormat === format}
                title={`${t(`format_${format}`)} — ${formatDimensions(format)}`}
                onClick={() => text.onFormat(format)}
              >
                <span className="settings-silhouette" style={{ width: `${String(widthMm * scale)}px`, height: `${String(heightMm * scale)}px` }} />
                <small>{t(`format_${format}`)}</small>
                <span className="settings-dim">{formatDimensions(format)}</span>
              </button>
            );
          })}
        </div>
      </fieldset>
      </section>
      <section className="settings-group">
        <h3 className="settings-group-title">{t("groupType")}</h3>
      <label className="settings-field">
        <span>{t("font")}</span>
        {mode === "screenplay" ? (
          <span className="settings-locked">{t("fontLocked")}</span>
        ) : (
          <select value={text.fontFamily} onChange={(event) => text.onFont(event.currentTarget.value)}>
            {fonts.map((font) => (
              <option key={font} value={font} style={{ fontFamily: font }}>
                {font}
              </option>
            ))}
          </select>
        )}
      </label>

      <div className="settings-field">
        <span>{t("size")}</span>
        {mode === "screenplay" ? (
          <span className="settings-locked">12 pt</span>
        ) : (
          <div className="settings-stepper">
            <button type="button" aria-label={t("smaller")} onClick={() => text.onSize(Math.max(8, text.baseFontSizePt - 0.5))}>
              −
            </button>
            <output>{text.baseFontSizePt.toLocaleString("fr-FR")} pt</output>
            <button type="button" aria-label={t("larger")} onClick={() => text.onSize(Math.min(24, text.baseFontSizePt + 0.5))}>
              +
            </button>
          </div>
        )}
      </div>

      <label className="settings-field">
        <span>{t("lang")}</span>
        <select value={text.lang} onChange={(event) => text.onLang(event.currentTarget.value === "en" ? "en" : "fr")}>
          <option value="fr">Français</option>
          <option value="en">English</option>
        </select>
      </label>

      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={text.lang === "fr" && french}
          disabled={text.lang !== "fr"}
          onChange={(event) => text.onFrenchTypography(event.currentTarget.checked)}
        />
        <span>
          {t("frenchTypography")} <small>{text.lang === "fr" ? t("frenchExample") : t("frenchEnglish")}</small>
        </span>
      </label>
      </section>

      {pendingMode !== null ? (
        <ModeConfirm
          from={mode}
          to={pendingMode}
          format={text.document.pageFormat}
          onCancel={() => setPendingMode(null)}
          onConfirm={() => {
            text.onMode(pendingMode);
            setPendingMode(null);
          }}
        />
      ) : null}
    </div>
  );
}

/** Confirmation qui liste les effets du changement de mode (AC-005, D-053). */
function ModeConfirm({
  from,
  to,
  format,
  onCancel,
  onConfirm,
}: {
  from: DocumentMode;
  to: DocumentMode;
  format: PageFormat;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useTranslate("settings");
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancel.current?.focus();
  }, []);
  const effects = [t("effectKept")];
  if (!FORMATS_BY_MODE[to].includes(format)) {
    effects.push(t("effectFormat", { format: t(`format_${defaultFormat(to)}`) }));
  }
  effects.push(t("effectFont", { font: fontsFor(to)[0] ?? "" }));
  if (from === "screenplay" || to === "screenplay") {
    effects.push(t("effectSpaces"));
  }
  effects.push(t("effectHistory"));
  return (
    <div className="dialog-veil" onClick={onCancel}>
      <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="mode-title" onClick={(event) => event.stopPropagation()}>
        <h2 id="mode-title">{t("modeConfirmTitle", { mode: t(`mode_${to}`) })}</h2>
        <ul>
          {effects.map((effect) => (
            <li key={effect}>{effect}</li>
          ))}
        </ul>
        <div className="dialog-actions">
          <button ref={cancel} type="button" onClick={onCancel}>
            {t("cancel")}
          </button>
          <button type="button" className="button-primary" onClick={onConfirm}>
            {t("modeConfirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

function GeneralTab({ onTrash }: { onTrash?: () => void }) {
  const t = useTranslate("settings");
  const { prefs, update } = usePreferences();
  const [spellWarning, setSpellWarning] = useState(false);
  const set = (patch: Partial<Preferences>) => update(patch);
  return (
    <div className="settings-section">
      <section className="settings-group">
        <h3 className="settings-group-title">{t("groupAppearance")}</h3>
      <fieldset className="settings-field">
        <legend>{t("theme")}</legend>
        <div className="settings-segmented">
          {(["light", "dark", "system"] as const).map((theme) => (
            <label key={theme} className="settings-radio">
              <input type="radio" name="theme" checked={prefs.theme === theme} onChange={() => set({ theme })} />
              <span>{t(`theme_${theme}`)}</span>
            </label>
          ))}
        </div>
      </fieldset>
      </section>
      <section className="settings-group">
        <h3 className="settings-group-title">{t("groupWriting")}</h3>


      <label className="settings-field">
        <span>{t("dailyGoal")}</span>
        <input
          type="number"
          min={0}
          max={100000}
          step={50}
          value={prefs.dailyWordGoal}
          onChange={(event) => {
            const value = Math.round(Number(event.currentTarget.value));
            if (Number.isFinite(value) && value >= 0 && value <= 100000) {
              set({ dailyWordGoal: value });
            }
          }}
        />
        <small>{t("dailyGoalHint")}</small>
      </label>

      <label className="settings-toggle">
        <input type="checkbox" checked={prefs.showWordCount} onChange={(event) => set({ showWordCount: event.currentTarget.checked })} />
        <span>{t("showWordCount")}</span>
      </label>
      <label className="settings-toggle">
        <input type="checkbox" checked={prefs.showDailyGoal} onChange={(event) => set({ showDailyGoal: event.currentTarget.checked })} />
        <span>{t("showDailyGoal")}</span>
      </label>

      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={prefs.frenchTypographyDefault}
          onChange={(event) => set({ frenchTypographyDefault: event.currentTarget.checked })}
        />
        <span>
          {t("frenchTypography")} <small>{t("frenchExample")}</small>
        </span>
      </label>

      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={prefs.spellcheck}
          onChange={(event) => {
            if (event.currentTarget.checked) {
              setSpellWarning(true);
            } else {
              set({ spellcheck: false });
            }
          }}
        />
        <span>{t("spellcheck")}</span>
      </label>
      {spellWarning ? (
        <div className="banner" role="alertdialog" aria-label={t("spellcheck")}>
          <p>{t("spellcheckWarning")}</p>
          <button type="button" onClick={() => setSpellWarning(false)}>
            {t("cancel")}
          </button>
          <button
            type="button"
            className="button-primary"
            onClick={() => {
              set({ spellcheck: true });
              setSpellWarning(false);
            }}
          >
            {t("spellcheckEnable")}
          </button>
        </div>
      ) : null}
      </section>
      <section className="settings-group">
        <h3 className="settings-group-title">{t("groupData")}</h3>
      {onTrash ? (
        <button type="button" className="settings-link" onClick={onTrash}>
          {t("trash")}
        </button>
      ) : null}
      {LOCAL_ONLY ? <LibraryBackup /> : <AccountExport />}
      </section>
    </div>
  );
}

/** Version de bureau : sauvegarde de toute la bibliothèque dans un fichier, et restauration. */
function LibraryBackup() {
  const t = useTranslate("settings");
  const local = useLocalStore();
  const picker = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (local.status !== "ready") {
    return null;
  }
  const { store } = local;
  const save = async () => {
    setBusy(true);
    try {
      const { bytes, name } = await exportLibrary(store);
      const saved = await saveFile(bytes, name, "application/json");
      setMessage(saved ? t("backupSaved") : null);
    } catch {
      setMessage(t("backupFailed"));
    } finally {
      setBusy(false);
    }
  };
  const restore = async (file: File) => {
    setBusy(true);
    try {
      const { added, skipped } = await importLibrary(store, file);
      setMessage(t("backupRestored", { added, skipped }));
    } catch (error) {
      setMessage(error instanceof BackupError && error.message === "newer" ? t("backupNewer") : t("backupInvalid"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="settings-field">
      <div className="settings-actions">
        <button type="button" disabled={busy} onClick={() => void save()}>
          {t("backupSave")}
        </button>
        <button type="button" disabled={busy} onClick={() => picker.current?.click()}>
          {t("backupRestore")}
        </button>
      </div>
      <input
        ref={picker}
        type="file"
        hidden
        accept=".flaw,application/json"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) {
            void restore(file);
          }
        }}
      />
      <small role="status">{message ?? t("backupHint")}</small>
    </div>
  );
}

/** Export complet du compte (AC-099) : archive ZIP de tous les textes et métadonnées. */
function AccountExport() {
  const t = useTranslate("settings");
  const [state, setState] = useState<"idle" | "busy" | "reauth" | "failed">("idle");
  const run = async () => {
    setState("busy");
    const response = await fetch("/api/v1/me/export", {
      method: "POST",
      headers: { [CSRF_HEADER]: CSRF_VALUE },
      credentials: "same-origin",
    }).catch(() => null);
    if (response?.status === 403) {
      setState("reauth");
      return;
    }
    if (!response?.ok) {
      setState("failed");
      return;
    }
    const name = /filename="([^"]+)"/u.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? "flaw-export.zip";
    download(new Uint8Array(await response.arrayBuffer()), name, "application/zip");
    setState("idle");
  };
  return (
    <div className="settings-field">
      <button type="button" disabled={state === "busy"} onClick={() => void run()}>
        {state === "busy" ? t("exportBusy") : t("exportAll")}
      </button>
      <small>{state === "reauth" ? t("exportReauth") : state === "failed" ? t("exportFailed") : t("exportAllHint")}</small>
    </div>
  );
}
