import { useTranslate } from "../i18n/i18n.ts";
import type { DocumentMode } from "../local-store/index.ts";

const COMMON: Array<[string, string]> = [
  ["shortcut_focus", "Ctrl/⌘+Maj+F"],
  ["shortcut_search", "Ctrl/⌘+F"],
  ["shortcut_back", "Alt+← / ⌘+["],
  ["shortcut_bold", "Ctrl/⌘+B"],
  ["shortcut_italic", "Ctrl/⌘+I"],
  ["shortcut_size", "Ctrl/⌘+Maj+. / ,"],
  ["shortcut_align", "Ctrl+Maj+7…0 / ⌘+⌥+7…0"],
  ["shortcut_undo", "Ctrl/⌘+Z"],
];

const BY_MODE: Record<DocumentMode, Array<[string, string]>> = {
  novel: [
    ["shortcut_chapter", "Ctrl/⌘+Maj+Entrée"],
    ["shortcut_sceneBreak", "*** puis Entrée"],
    ["shortcut_goToChapter", "Ctrl+Alt+G / ⌘+⌥+G"],
  ],
  screenplay: [
    ["shortcut_elementNext", "Entrée / Tab"],
    ["shortcut_elementBack", "Maj+Tab"],
    ["shortcut_elements", "Ctrl+Maj+1…6 / ⌘+⌥+1…6"],
  ],
  document: [
    ["shortcut_headings", "Ctrl+Maj+1…3 / ⌘+⌥+1…3, # ## ###"],
    ["shortcut_lists", "Ctrl+Maj+4/5 / ⌘+⌥+4/5, - 1."],
    ["shortcut_indent", "Tab / Maj+Tab"],
  ],
  blank: [],
};

/** Fiche des raccourcis (D-104), propre au mode du texte. */
export function Shortcuts({ mode, onClose }: { mode: DocumentMode; onClose: () => void }) {
  const t = useTranslate("editor");
  return (
    <div className="dialog-veil" onClick={onClose}>
      <div className="dialog shortcuts" role="dialog" aria-label={t("menu_shortcuts")} onClick={(event) => event.stopPropagation()}>
        <h2>{t("menu_shortcuts")}</h2>
        <dl>
          {[...BY_MODE[mode], ...COMMON].map(([key, keys]) => (
            <div key={key}>
              <dt>{t(key)}</dt>
              <dd>
                <kbd>{keys}</kbd>
              </dd>
            </div>
          ))}
        </dl>
        <div className="dialog-actions">
          <button type="button" autoFocus onClick={onClose}>
            {t("close")}
          </button>
        </div>
      </div>
    </div>
  );
}
