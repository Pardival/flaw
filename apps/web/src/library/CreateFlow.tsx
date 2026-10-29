import { useEffect, useRef, useState } from "react";

import { useTranslate } from "../i18n/i18n.ts";
import { pageSize } from "../layout/formats.ts";
import { DOCUMENT_MODES, type DocumentMode, type LocalStore, type PageFormat } from "../local-store/index.ts";
import { FORMATS_BY_MODE, defaultFormat, formatCm, formatDimensions, formatMarginsCm } from "./formats-by-mode.ts";
import { navigate } from "./route.ts";

/** Création en deux étapes : mode (D-024) puis format (D-025). Hors ligne possible (A-004). */
export function CreateFlow({ store }: { store: LocalStore }) {
  const t = useTranslate("library");
  const [mode, setMode] = useState<DocumentMode | null>(null);
  const [focusMode, setFocusMode] = useState<DocumentMode>("novel");
  const [format, setFormat] = useState<PageFormat>("novel_13x20");
  const [busy, setBusy] = useState(false);
  const firstChoice = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstChoice.current?.focus();
  }, [mode]);

  const close = () => {
    navigate({ name: "list" });
  };

  const chooseMode = (next: DocumentMode) => {
    setMode(next);
    setFormat(defaultFormat(next));
  };

  const start = async () => {
    if (mode === null || busy) {
      return;
    }
    setBusy(true);
    try {
      const doc = await store.createDocument({ mode, pageFormat: format, title: t("untitled") });
      navigate({ name: "text", id: doc.id }, { replace: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="create"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          if (mode === null) {
            close();
          } else {
            setMode(null);
          }
        }
      }}
    >
      <header className="create-bar">
        <ol className="create-steps">
          <li aria-current={mode === null ? "step" : undefined}>
            {mode === null ? "(1)" : "(✓)"} {mode === null ? t("stepMode") : t(`mode_${mode}`)}
          </li>
          <li aria-current={mode !== null ? "step" : undefined}>(2) {t("stepFormat")}</li>
        </ol>
        <button type="button" className="icon-button" aria-label={t("close")} onClick={close}>
          ×
        </button>
      </header>

      {mode === null ? (
        <form
          className="create-step"
          onSubmit={(event) => {
            event.preventDefault();
            chooseMode(focusMode);
          }}
        >
          <h1>{t("modeQuestion")}</h1>
          <fieldset className="mode-grid">
            <legend className="visually-hidden">{t("stepMode")}</legend>
            {DOCUMENT_MODES.map((item, index) => (
              <label key={item} className="mode-card" data-mode={item}>
                <input
                  ref={index === 0 ? firstChoice : undefined}
                  type="radio"
                  name="mode"
                  value={item}
                  checked={focusMode === item}
                  onChange={() => {
                    setFocusMode(item);
                  }}
                  onDoubleClick={() => {
                    chooseMode(item);
                  }}
                />
                <span className="mode-name">{t(`mode_${item}`)}</span>
                <span className="mode-hint">{t(`modeHint_${item}`)}</span>
              </label>
            ))}
          </fieldset>
          <div className="create-actions">
            <button type="submit" className="button-primary">
              {t("next")}
            </button>
          </div>
        </form>
      ) : (
        <form
          className="create-step create-format"
          onSubmit={(event) => {
            event.preventDefault();
            void start();
          }}
        >
          <div className="create-choices">
            <h1>{t("formatQuestion")}</h1>
            <Silhouettes formats={FORMATS_BY_MODE[mode]} selected={format} onSelect={setFormat} />
            <fieldset className="format-list">
              <legend className="visually-hidden">{t("stepFormat")}</legend>
              {FORMATS_BY_MODE[mode].map((item, index) => (
                <label key={item} className="format-option">
                  <input
                    ref={index === 0 ? firstChoice : undefined}
                    type="radio"
                    name="format"
                    value={item}
                    checked={format === item}
                    onChange={() => {
                      setFormat(item);
                    }}
                  />
                  <span>
                    {t(`format_${item}`)} — {formatDimensions(item)}
                    {index === 0 ? ` ${t("defaultSuffix")}` : ""}
                  </span>
                </label>
              ))}
            </fieldset>
            <p className="create-note">ⓘ {t("formatNote")}</p>
            <div className="create-actions">
              <button
                type="button"
                onClick={() => {
                  setMode(null);
                }}
              >
                {t("backToMode")}
              </button>
              <button type="submit" className="button-primary" disabled={busy}>
                {t("start")}
              </button>
            </div>
          </div>
          <PagePreview mode={mode} format={format} />
        </form>
      )}
    </div>
  );
}

/** Silhouettes à la même échelle pour comparer les tailles. */
function Silhouettes({
  formats,
  selected,
  onSelect,
}: {
  formats: readonly PageFormat[];
  selected: PageFormat;
  onSelect: (format: PageFormat) => void;
}) {
  const scale = 120 / Math.max(...formats.map((item) => pageSize(item).heightMm));
  return (
    <div className="silhouettes" aria-hidden="true">
      {formats.map((item) => {
        const { widthMm, heightMm } = pageSize(item);
        return (
          <div
            key={item}
            className="silhouette"
            data-selected={item === selected ? "true" : "false"}
            style={{ width: `${String(widthMm * scale)}px`, height: `${String(heightMm * scale)}px` }}
            onClick={() => {
              onSelect(item);
            }}
          />
        );
      })}
    </div>
  );
}

/** Aperçu aux vraies proportions, marges en pointillés, cotes en cm. */
function PagePreview({ mode, format }: { mode: DocumentMode; format: PageFormat }) {
  const t = useTranslate("library");
  const { widthMm, heightMm } = pageSize(format);
  const [top, right, bottom, left] = formatMarginsCm(format, mode);
  const pct = (cm: number, totalMm: number) => `${String((cm * 1000) / totalMm)}%`;
  return (
    <figure className="page-preview" aria-hidden="true">
      <figcaption className="preview-width">{t("widthCm", { value: formatCm(widthMm) })}</figcaption>
      <div className="preview-row">
        <div className="preview-sheet" style={{ aspectRatio: `${String(widthMm)} / ${String(heightMm)}` }}>
          <div
            className="preview-margins"
            style={{
              top: pct(top, heightMm),
              right: pct(right, widthMm),
              bottom: pct(bottom, heightMm),
              left: pct(left, widthMm),
            }}
          >
            <span />
            <span />
            <span />
            <span />
            <span className="short" />
          </div>
        </div>
        <span className="preview-height">{t("heightCm", { value: formatCm(heightMm) })}</span>
      </div>
    </figure>
  );
}
