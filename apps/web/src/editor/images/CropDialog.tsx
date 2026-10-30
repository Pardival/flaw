import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { useTranslate } from "../../i18n/i18n.ts";
import type { Crop } from "./process.ts";
import { useClosing } from "../../shell/presence.ts";

type Aspect = { key: string; value: number | null };

/** Rapports proposés (largeur / hauteur) ; `page` = celui de la page du livre. */
function aspects(page: number | undefined): Aspect[] {
  return [
    { key: "free", value: null },
    ...(page !== undefined ? [{ key: "page", value: page }] : []),
    { key: "square", value: 1 },
    { key: "landscape", value: 4 / 3 },
    { key: "wide", value: 16 / 9 },
    { key: "portrait", value: 3 / 4 },
  ];
}

type Drag = { mode: "move" | "nw" | "ne" | "sw" | "se"; x: number; y: number; start: Crop };

const MIN = 0.05;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Recadre en respectant le rapport demandé (dans l'espace de l'image). */
function fitAspect(crop: Crop, aspect: number | null, imageRatio: number): Crop {
  if (aspect === null) return crop;
  const [x, y, w, h] = crop;
  // aspect en pixels → en fractions : w_frac / h_frac = aspect * imageRatio (imageRatio = h/w de l'image).
  const target = aspect * imageRatio;
  let nw = w;
  let nh = w / target;
  if (nh > 1) {
    nh = 1;
    nw = target;
  }
  if (nw > 1) {
    nw = 1;
    nh = 1 / target;
  }
  const cx = x + w / 2;
  const cy = y + h / 2;
  return [clamp(cx - nw / 2, 0, 1 - nw), clamp(cy - nh / 2, 0, 1 - nh), nw, nh];
}

/**
 * Recadrage d'une image : on déplace le cadre, on tire ses coins ; le rapport peut
 * être libre, celui de la page, carré, paysage ou portrait. L'original est gardé.
 */
export function CropDialog({
  src,
  initial,
  pageAspect,
  title,
  onApply,
  onClose: closeNow,
}: {
  src: string;
  initial: Crop | null;
  pageAspect?: number;
  title?: string;
  onApply: (crop: Crop | null) => void;
  onClose: () => void;
}) {
  const t = useTranslate("editor");
  const { closing, close: onClose } = useClosing(closeNow);
  const [crop, setCrop] = useState<Crop>(initial ?? [0, 0, 1, 1]);
  const [aspect, setAspect] = useState<number | null>(null);
  const [imageRatio, setImageRatio] = useState(1);
  const area = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const choices = aspects(pageAspect);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const begin = (mode: Drag["mode"]) => (event: ReactPointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    drag.current = { mode, x: event.clientX, y: event.clientY, start: crop };
  };

  const move = (event: ReactPointerEvent) => {
    const current = drag.current;
    const box = area.current?.getBoundingClientRect();
    if (current === null || box === undefined) return;
    const dx = (event.clientX - current.x) / box.width;
    const dy = (event.clientY - current.y) / box.height;
    const [x, y, w, h] = current.start;
    if (current.mode === "move") {
      setCrop([clamp(x + dx, 0, 1 - w), clamp(y + dy, 0, 1 - h), w, h]);
      return;
    }
    let left = x;
    let top = y;
    let right = x + w;
    let bottom = y + h;
    if (current.mode.includes("w")) left = clamp(x + dx, 0, right - MIN);
    if (current.mode.includes("e")) right = clamp(x + w + dx, left + MIN, 1);
    if (current.mode.includes("n")) top = clamp(y + dy, 0, bottom - MIN);
    if (current.mode.includes("s")) bottom = clamp(y + h + dy, top + MIN, 1);
    let next: Crop = [left, top, right - left, bottom - top];
    if (aspect !== null) {
      const target = aspect * imageRatio;
      const width = right - left;
      let height = width / target;
      if (current.mode.includes("n")) top = bottom - height;
      if (top < 0 || top + height > 1) {
        height = current.mode.includes("n") ? bottom : 1 - top;
        const fitted = height * target;
        if (current.mode.includes("w")) left = right - fitted;
        else right = left + fitted;
        top = current.mode.includes("n") ? bottom - height : top;
      }
      next = [left, top, right - left, height];
    }
    setCrop(next);
  };

  const end = () => {
    drag.current = null;
  };

  const [x, y, w, h] = crop;
  const percent = (value: number) => `${String(value * 100)}%`;

  return (
    <div className={`dialog-veil${closing ? " is-closing" : ""}`} onClick={onClose}>
      <div className="dialog crop-dialog" role="dialog" aria-label={title ?? t("cropTitle")} onClick={(event) => event.stopPropagation()}>
        <h2>{title ?? t("cropTitle")}</h2>
        <div className="crop-aspects" role="radiogroup" aria-label={t("cropAspect")}>
          {choices.map((choice) => (
            <button
              key={choice.key}
              type="button"
              role="radio"
              aria-checked={aspect === choice.value}
              onClick={() => {
                setAspect(choice.value);
                setCrop((current) => fitAspect(current, choice.value, imageRatio));
              }}
            >
              {t(`aspect_${choice.key}`)}
            </button>
          ))}
        </div>
        <div className="crop-stage">
          <div ref={area} className="crop-area" onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
            <img
              src={src}
              alt=""
              draggable={false}
              onLoad={(event) => {
                const image = event.currentTarget;
                setImageRatio(image.naturalHeight / Math.max(1, image.naturalWidth));
              }}
            />
            <div className="crop-shade" style={{ clipPath: `polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${percent(x)} ${percent(y)}, ${percent(x)} ${percent(y + h)}, ${percent(x + w)} ${percent(y + h)}, ${percent(x + w)} ${percent(y)}, ${percent(x)} ${percent(y)})` }} />
            <div
              className="crop-box"
              style={{ left: percent(x), top: percent(y), width: percent(w), height: percent(h) }}
              onPointerDown={begin("move")}
            >
              {(["nw", "ne", "sw", "se"] as const).map((corner) => (
                <span key={corner} className={`crop-handle crop-${corner}`} onPointerDown={begin(corner)} />
              ))}
            </div>
          </div>
        </div>
        <div className="dialog-actions">
          <button type="button" onClick={() => setCrop([0, 0, 1, 1])}>
            {t("cropReset")}
          </button>
          <span className="dialog-actions-spacer" />
          <button type="button" onClick={onClose}>
            {t("cancel")}
          </button>
          <button
            type="button"
            className="button-primary"
            onClick={() => {
              const full = x <= 0.001 && y <= 0.001 && w >= 0.999 && h >= 0.999;
              onApply(full ? null : crop);
            }}
          >
            {t("cropApply")}
          </button>
        </div>
      </div>
    </div>
  );
}
