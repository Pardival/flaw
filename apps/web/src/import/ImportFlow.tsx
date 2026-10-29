import { documentFromJson, emptyDocument } from "@flaw/schema/src/index.ts";
import { toDocument, type ImportErrorCode, type ImportMode, type ImportResult } from "@flaw/importers/src/index.ts";
import { useEffect, useRef, useState } from "react";
import { prosemirrorToYXmlFragment } from "y-prosemirror";

import { useTranslate } from "../i18n/i18n.ts";
import { FORMATS_BY_MODE, defaultFormat } from "../library/formats-by-mode.ts";
import { navigate } from "../library/route.ts";
import { DOCUMENT_MODES, PROSEMIRROR_FRAGMENT, type LocalStore, type PageFormat } from "../local-store/index.ts";
import { precheck, startImport, type ImportJob } from "./run.ts";

type State =
  | { name: "busy"; file: string; job: ImportJob }
  | { name: "error"; code: ImportErrorCode; file: string }
  | { name: "confirm"; result: ImportResult; mode: ImportMode; format: PageFormat };

/**
 * Parcours d'import (T-040, D-013 à D-018) : un fichier à la fois, traité sur
 * l'appareil ; mode proposé et modifiable ; toujours un nouveau texte.
 */
export function ImportFlow({ store, file, onClose }: { store: LocalStore; file: File; onClose: () => void }) {
  const t = useTranslate("import");
  const [state, setState] = useState<State | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) {
      return;
    }
    started.current = true;
    const refused = precheck(file);
    if (refused !== null) {
      setState({ name: "error", code: refused, file: file.name });
      return;
    }
    const job = startImport(file);
    setState({ name: "busy", file: file.name, job });
    void job.promise.then((response) => {
      if (response.ok) {
        const mode = response.result.suggestedMode;
        setState({ name: "confirm", result: response.result, mode, format: defaultFormat(mode) });
      } else {
        setState({ name: "error", code: response.code, file: file.name });
      }
    });
  }, [file]);

  const create = async (result: ImportResult, mode: ImportMode, format: PageFormat) => {
    const json = toDocument(result.blocks, mode);
    let node;
    try {
      node = documentFromJson(json);
    } catch {
      node = emptyDocument(mode);
    }
    const lower = file.name.toLowerCase();
    const doc = await store.createDocument({
      mode,
      pageFormat: format,
      title: result.title.slice(0, 300),
      importedFrom: lower.endsWith(".docx") ? "docx" : lower.endsWith(".txt") ? "txt" : "md",
    });
    const ydoc = await store.openDocument(doc.id);
    const fragment = ydoc.getXmlFragment(PROSEMIRROR_FRAGMENT);
    if (fragment.length === 0) {
      ydoc.transact(() => {
        prosemirrorToYXmlFragment(node, fragment);
      });
    }
    await store.captureEdits(doc.id);
    onClose();
    navigate({ name: "text", id: doc.id });
  };

  if (state === null) {
    return null;
  }

  return (
    <div className="dialog-veil">
      <div className="dialog import-dialog" role="dialog" aria-labelledby="import-title">
        {state.name === "busy" ? (
          <>
            <h2 id="import-title">{t("reading", { name: state.file })}</h2>
            <p>{t("onDevice")}</p>
            <div className="dialog-actions">
              <button
                type="button"
                onClick={() => {
                  state.job.cancel();
                  onClose();
                }}
              >
                {t("cancel")}
              </button>
            </div>
          </>
        ) : null}
        {state.name === "error" ? (
          <>
            <h2 id="import-title">{t(state.code === "zip_archive" ? "zipTitle" : state.code === "unsupported" || state.code === "not_zip" || state.code === "ole" ? "unknownTitle" : "refusedTitle", { name: state.file })}</h2>
            <p>{t(`error_${state.code}`, { defaultValue: t("error_generic") })}</p>
            <p className="library-meta">{t("accepted")}</p>
            <div className="dialog-actions">
              <button type="button" autoFocus onClick={onClose}>
                {t("close")}
              </button>
            </div>
          </>
        ) : null}
        {state.name === "confirm" ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void create(state.result, state.mode, state.format);
            }}
          >
            <h2 id="import-title">{t("confirmTitle", { title: state.result.title })}</h2>
            {state.result.report.simplified || state.result.report.windows1252 ? (
              <p className="banner" role="status">
                {state.result.report.windows1252 ? t("windows1252") : t("simplified")}
                {state.result.report.invisible > 0 ? ` ${t("invisible", { count: state.result.report.invisible })}` : ""}
              </p>
            ) : null}
            <fieldset className="settings-field">
              <legend>{t("mode")}</legend>
              {DOCUMENT_MODES.map((mode) => (
                <label key={mode} className="settings-radio">
                  <input
                    type="radio"
                    name="mode"
                    checked={state.mode === mode}
                    onChange={() => setState({ ...state, mode, format: defaultFormat(mode) })}
                  />
                  <span>
                    {t(`mode_${mode}`)}
                    {mode === state.result.suggestedMode ? ` ${t("suggested")}` : ""}
                  </span>
                </label>
              ))}
            </fieldset>
            <label className="settings-field">
              <span>{t("format")}</span>
              <select value={state.format} onChange={(event) => setState({ ...state, format: event.currentTarget.value as PageFormat })}>
                {FORMATS_BY_MODE[state.mode].map((format) => (
                  <option key={format} value={format}>
                    {t(`format_${format}`)}
                  </option>
                ))}
              </select>
            </label>
            <p className="library-meta">{t("newText")}</p>
            <div className="dialog-actions">
              <button type="button" onClick={onClose}>
                {t("cancel")}
              </button>
              <button type="submit" className="button-primary" autoFocus>
                {t("import")}
              </button>
            </div>
          </form>
        ) : null}
      </div>
    </div>
  );
}

