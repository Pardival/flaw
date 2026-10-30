import { useEffect, useRef, useState } from "react";
import type * as Y from "yjs";

import { useTranslate } from "../i18n/i18n.ts";
import { Icon } from "../shell/Icon.tsx";
import { assetUrl, getAsset, putAsset } from "../editor/images/assets.ts";
import { CropDialog } from "../editor/images/CropDialog.tsx";
import { isImageFile, prepareImage, type Crop } from "../editor/images/process.ts";
import {
  BACK_TEXT_MAX,
  COVER_FONTS,
  COVER_PALETTES,
  COVER_TEMPLATES,
  defaultCover,
  readCover,
  writeCover,
  type Cover,
} from "./model.ts";
import { drawCover, loadCoverFonts, type Side } from "./render.ts";
import { useClosing } from "../shell/presence.ts";

type Bitmap = CanvasImageSource & { width: number; height: number };

/** Image de la couverture décodée pour le canvas. */
function useCoverBitmap(doc: Y.Doc, asset: string | null): Bitmap | null {
  const [bitmap, setBitmap] = useState<Bitmap | null>(null);
  useEffect(() => {
    if (asset === null) {
      setBitmap(null);
      return;
    }
    const bytes = getAsset(doc, asset);
    if (bytes === null) return;
    let alive = true;
    void createImageBitmap(new Blob([bytes as BlobPart])).then((decoded) => {
      if (alive) setBitmap(decoded);
      else decoded.close();
    });
    return () => {
      alive = false;
    };
  }, [doc, asset]);
  return bitmap;
}

function Preview({
  side,
  cover,
  ratio,
  image,
  label,
  active,
  onSelect,
}: {
  side: Side;
  cover: Cover;
  ratio: number;
  image: Bitmap | null;
  label: string;
  active: boolean;
  onSelect: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let alive = true;
    void loadCoverFonts(cover).then(() => {
      const element = canvas.current;
      if (!alive || element === null) return;
      const width = element.clientWidth * Math.min(2, window.devicePixelRatio || 1);
      element.width = Math.max(1, Math.round(width));
      element.height = Math.max(1, Math.round(width * ratio));
      const context = element.getContext("2d");
      if (context !== null) drawCover(context, side, cover, element.width, element.height, image);
    });
    return () => {
      alive = false;
    };
  }, [side, cover, ratio, image]);
  // Cliquer sur une face l'ouvre dans le panneau de droite.
  return (
    <button type="button" role="tab" aria-selected={active} className="cover-preview" onClick={onSelect}>
      <canvas ref={canvas} style={{ aspectRatio: `1 / ${String(ratio)}` }} aria-hidden="true" />
      <span className="cover-preview-label">{label}</span>
    </button>
  );
}

/**
 * Atelier de couverture : 1re (modèle, titre, sous-titre, auteur, image, couleurs,
 * police) et 4e (résumé). Aperçu au format du livre ; chaque changement est enregistré.
 */
export function CoverStudio({ doc, title, pageMm, onClose: closeNow }: { doc: Y.Doc; title: string; pageMm: { width: number; height: number }; onClose: () => void }) {
  const t = useTranslate("cover");
  const { closing, close: onClose } = useClosing(closeNow);
  const [cover, setCover] = useState<Cover>(() => readCover(doc) ?? defaultCover(title));
  const [side, setSide] = useState<Side>("front");
  const [cropping, setCropping] = useState(false);
  const [error, setError] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const ratio = pageMm.height / pageMm.width;
  const image = useCoverBitmap(doc, cover.image?.asset ?? null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !cropping) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, cropping]);

  const update = (patch: Partial<Cover>) => {
    setCover((current) => {
      const next = { ...current, ...patch };
      writeCover(doc, next);
      return next;
    });
  };

  const chooseImage = async (file: File) => {
    try {
      const prepared = await prepareImage(file);
      const asset = await putAsset(doc, prepared.bytes);
      update({ image: { asset, original: null, crop: null }, template: cover.template === "classic" || cover.template === "minimal" ? cover.template : cover.template });
      setError(false);
    } catch {
      setError(true);
    }
  };

  const applyCrop = async (crop: Crop | null) => {
    if (cover.image === null) return;
    const originalId = cover.image.original ?? cover.image.asset;
    const bytes = getAsset(doc, originalId);
    if (bytes === null) return;
    if (crop === null) {
      update({ image: { asset: originalId, original: null, crop: null } });
      return;
    }
    const prepared = await prepareImage(new Blob([bytes as BlobPart]), crop);
    update({ image: { asset: await putAsset(doc, prepared.bytes), original: originalId, crop } });
  };

  const cropSource = cover.image ? assetUrl(doc, cover.image.original ?? cover.image.asset) : null;

  return (
    <div className={`dialog-veil cover-veil${closing ? " is-closing" : ""}`} onClick={onClose}>
      <div className="cover-studio" role="dialog" aria-label={t("title")} onClick={(event) => event.stopPropagation()}>
        <header className="cover-head">
          <h2>{t("title")}</h2>
          <p className="cover-hint">{t("pickSide")}</p>
          <button type="button" className="icon-button" aria-label={t("close")} onClick={onClose}>
            <Icon name="close" size={16} />
          </button>
        </header>
        <div className="cover-body">
          <div className="cover-stage" role="tablist" aria-label={t("title")} data-side={side}>
            <Preview side="back" cover={cover} ratio={ratio} image={image} label={t("back")} active={side === "back"} onSelect={() => setSide("back")} />
            <Preview side="front" cover={cover} ratio={ratio} image={image} label={t("front")} active={side === "front"} onSelect={() => setSide("front")} />
          </div>
          <div className="cover-form" key={side} role="tabpanel">
            <h3 className="cover-form-title">{side === "front" ? t("front") : t("back")}</h3>
            {side === "front" ? (
              <>
                <fieldset className="settings-field">
                  <legend>{t("template")}</legend>
                  <div className="cover-chips">
                    {COVER_TEMPLATES.map((template) => (
                      <button key={template} type="button" aria-pressed={cover.template === template} onClick={() => update({ template })}>
                        {t(`template_${template}`)}
                      </button>
                    ))}
                  </div>
                </fieldset>
                <label className="settings-field">
                  <span>{t("bookTitle")}</span>
                  <input value={cover.title} maxLength={200} onChange={(event) => update({ title: event.currentTarget.value })} />
                </label>
                <label className="settings-field">
                  <span>{t("subtitle")}</span>
                  <input value={cover.subtitle} maxLength={200} placeholder={t("optional")} onChange={(event) => update({ subtitle: event.currentTarget.value })} />
                </label>
                <label className="settings-field">
                  <span>{t("author")}</span>
                  <input value={cover.author} maxLength={120} onChange={(event) => update({ author: event.currentTarget.value })} />
                </label>
                <div className="settings-field">
                  <span>{t("image")}</span>
                  <div className="settings-actions">
                    <button type="button" onClick={() => picker.current?.click()}>
                      {cover.image ? t("replaceImage") : t("addImage")}
                    </button>
                    {cover.image ? (
                      <>
                        <button type="button" onClick={() => setCropping(true)}>
                          {t("cropImage")}
                        </button>
                        <button type="button" onClick={() => update({ image: null })}>
                          {t("removeImage")}
                        </button>
                      </>
                    ) : null}
                  </div>
                  <small>{error ? t("imageFailed") : t("imageHint")}</small>
                  <input
                    ref={picker}
                    type="file"
                    hidden
                    accept="image/jpeg,image/png,image/webp,image/gif,image/heic,image/avif"
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = "";
                      if (file && isImageFile(file)) void chooseImage(file);
                    }}
                  />
                </div>
              </>
            ) : (
              <>
                <label className="settings-field">
                  <span>{t("backText")}</span>
                  <textarea
                    value={cover.backText}
                    maxLength={BACK_TEXT_MAX}
                    rows={9}
                    placeholder={t("backPlaceholder")}
                    onChange={(event) => update({ backText: event.currentTarget.value })}
                  />
                  <small>
                    {cover.backText.length} / {BACK_TEXT_MAX}
                  </small>
                </label>
                <label className="settings-toggle">
                  <input type="checkbox" checked={cover.backShowTitle} onChange={(event) => update({ backShowTitle: event.currentTarget.checked })} />
                  <span>{t("backShowTitle")}</span>
                </label>
              </>
            )}
            <fieldset className="settings-field">
              <legend>{t("colors")}</legend>
              <div className="cover-swatches">
                {COVER_PALETTES.map((palette) => (
                  <button
                    key={palette.key}
                    type="button"
                    aria-pressed={cover.palette === palette.key}
                    aria-label={t(`palette_${palette.key}`)}
                    title={t(`palette_${palette.key}`)}
                    style={{ background: palette.background, color: palette.ink, borderColor: palette.accent }}
                    onClick={() => update({ palette: palette.key })}
                  >
                    Aa
                  </button>
                ))}
              </div>
            </fieldset>
            <label className="settings-field">
              <span>{t("font")}</span>
              <select value={cover.font} onChange={(event) => update({ font: event.currentTarget.value as Cover["font"] })}>
                {COVER_FONTS.map((font) => (
                  <option key={font} value={font}>
                    {font}
                  </option>
                ))}
              </select>
            </label>
            <div className="cover-footer">
              <button
                type="button"
                className="settings-link"
                onClick={() => {
                  writeCover(doc, null);
                  onClose();
                }}
              >
                {t("remove")}
              </button>
              <span className="cover-footer-spacer" />
              <button type="button" className="button-primary" onClick={onClose}>
                {t("done")}
              </button>
            </div>
          </div>
        </div>
      </div>
      {cropping && cropSource ? (
        <CropDialog
          src={cropSource}
          initial={cover.image?.crop ?? null}
          pageAspect={pageMm.width / pageMm.height}
          title={t("cropImage")}
          onClose={() => setCropping(false)}
          onApply={(crop) => {
            setCropping(false);
            void applyCrop(crop);
          }}
        />
      ) : null}
    </div>
  );
}
