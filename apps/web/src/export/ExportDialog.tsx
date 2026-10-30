import { formatsForMode, type ExportKind } from "@flaw/exporters/src/formats.ts";
import type { ExportAsset, ExportInput } from "@flaw/exporters/src/model.ts";
import { useEffect, useRef, useState } from "react";

import { useTranslate } from "../i18n/i18n.ts";
import { download, runExport } from "./run.ts";
import { exportPdf, type PdfOptions } from "./pdf.ts";

/**
 * Export (D-054, D-055) : formats du mode seulement (AC-047), fichier créé sur
 * l'appareil ; PDF roman : marges alternées et chapitres en belle page par défaut.
 */
type CoverSource = (include: boolean) => Promise<{ front?: ExportAsset; back?: ExportAsset } | undefined>;

export function ExportDialog({
  input,
  id,
  onClose,
  cover,
  hasCover = false,
  onEditCover,
}: {
  input: () => ExportInput;
  id: string;
  onClose: () => void;
  cover?: CoverSource;
  hasCover?: boolean;
  onEditCover?: () => void;
}) {
  const t = useTranslate("export");
  const mode = input().mode;
  const kinds = formatsForMode(mode);
  const [kind, setKind] = useState<ExportKind>(kinds[0] ?? "pdf");
  const [options, setOptions] = useState<PdfOptions>({ mirrorMargins: mode === "novel", chaptersOnRecto: mode === "novel" });
  const [state, setState] = useState<"idle" | "busy" | "failed">("idle");
  const [withCover, setWithCover] = useState(true);
  const coverable = kind !== "fountain";
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    first.current?.focus();
  }, []);

  const start = async () => {
    setState("busy");
    const covers = cover && hasCover && coverable ? await cover(withCover).catch(() => undefined) : undefined;
    const data = { ...input(), ...(covers ? { cover: covers } : {}) };
    if (kind === "pdf") {
      const result = await exportPdf(data, id, options);
      if (result.ok) {
        download(result.bytes, result.name, "application/pdf");
        onClose();
        return;
      }
      setState("failed");
      return;
    }
    const result = await runExport({ kind, input: data, id });
    if (result.ok) {
      download(result.bytes, result.name, result.mime);
      onClose();
    } else {
      setState("failed");
    }
  };

  return (
    <div className="dialog-veil" onClick={onClose}>
      <form
        className="dialog export-dialog"
        role="dialog"
        aria-labelledby="export-title"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
      >
        <h2 id="export-title">{t("title")}</h2>
        <fieldset className="settings-field">
          <legend>{t("format")}</legend>
          {kinds.map((item, index) => (
            <label key={item} className="settings-radio">
              <input ref={index === 0 ? first : undefined} type="radio" name="kind" checked={kind === item} onChange={() => setKind(item)} />
              <span>
                {t(`kind_${item}`)} <small>{t(`hint_${item}`)}</small>
              </span>
            </label>
          ))}
        </fieldset>
        {kind === "pdf" && mode === "novel" ? (
          <fieldset className="settings-field">
            <legend>{t("pdfOptions")}</legend>
            <label className="settings-toggle">
              <input type="checkbox" checked={options.mirrorMargins} onChange={(event) => setOptions({ ...options, mirrorMargins: event.currentTarget.checked })} />
              <span>{t("mirrorMargins")}</span>
            </label>
            <label className="settings-toggle">
              <input type="checkbox" checked={options.chaptersOnRecto} onChange={(event) => setOptions({ ...options, chaptersOnRecto: event.currentTarget.checked })} />
              <span>{t("chaptersOnRecto")}</span>
            </label>
          </fieldset>
        ) : null}
        {cover && coverable ? (
          <fieldset className="settings-field">
            <legend>{t("cover")}</legend>
            {hasCover ? (
              <label className="settings-toggle">
                <input type="checkbox" checked={withCover} onChange={(event) => setWithCover(event.currentTarget.checked)} />
                <span>{t("includeCover")}</span>
              </label>
            ) : null}
            {onEditCover ? (
              <button type="button" className="settings-link" onClick={onEditCover}>
                {hasCover ? t("editCover") : t("createCover")}
              </button>
            ) : null}
          </fieldset>
        ) : null}
        {state === "failed" ? (
          <p className="banner" role="alert">
            {kind === "pdf" ? t("pdfFailed") : t("failed")}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            {t("cancel")}
          </button>
          {state === "failed" && kind === "pdf" ? (
            <button type="button" onClick={() => setKind("docx")}>
              {t("tryWord")}
            </button>
          ) : null}
          <button type="submit" className="button-primary" disabled={state === "busy"}>
            {state === "busy" ? t("busy") : t("export")}
          </button>
        </div>
      </form>
    </div>
  );
}
