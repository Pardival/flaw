import { useEffect, useRef, useState } from "react";

import { useTranslate, uiLocale } from "../../i18n/i18n.ts";
import { retryNow } from "../../sync-client/connection.ts";
import { dismissBanner, useSyncStatus, type Banner } from "../../sync-client/status.ts";

const TIME = { format: (value: Date | number) => new Intl.DateTimeFormat(uiLocale(), { hour: "2-digit", minute: "2-digit" }).format(value) };

/** « Enregistrement… » n'apparaît qu'au-delà de 500 ms (A-025). */
function useDelayedSaving(saving: boolean): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!saving) {
      setShown(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setShown(true);
    }, 500);
    return () => {
      window.clearTimeout(timer);
    };
  }, [saving]);
  return shown;
}

/**
 * Indicateur de synchro (D-040, D-042, D-043, D-044) : liste et barre de l'éditeur,
 * jamais pendant la frappe ni en focus (l'appelant le masque avec la barre).
 */
export function SyncIndicator({ onReconnect }: { onReconnect?: () => void }) {
  const t = useTranslate("sync");
  const status = useSyncStatus();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const savingShown = useDelayedSaving(status.state === "saving");
  const state = status.state === "saving" && !savingShown ? "saved-local" : status.state;
  const phone = typeof window !== "undefined" && window.innerWidth < 600;
  const label = state === "error" && phone ? t("errorShort") : t(state);
  const detailed = state === "offline" || state === "auth-expired" || state === "update-required" || state === "error";

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  const last =
    status.lastSyncedAt === null ? t("never") : t("lastSync", { time: TIME.format(new Date(status.lastSyncedAt)) });

  return (
    <div ref={root} className="sync-indicator" data-state={state}>
      <button
        type="button"
        className="sync-trigger"
        aria-expanded={detailed ? open : undefined}
        onClick={() => {
          if (detailed) {
            setOpen(!open);
          }
        }}
      >
        <span className="sync-dot" aria-hidden="true" />
        {label}
      </button>
      {open && detailed ? (
        <div className="sync-popover" role="dialog" aria-label={label}>
          {state === "offline" ? <p>{t("offlineDetail")}</p> : null}
          {state === "auth-expired" ? (
            <>
              <p>{t("authDetail")}</p>
              <button type="button" className="button-primary" onClick={onReconnect ?? (() => window.location.reload())}>
                {t("reconnect")}
              </button>
            </>
          ) : null}
          {state === "update-required" ? (
            <>
              <p>{t("updateDetail")}</p>
              <button type="button" className="button-primary" onClick={() => window.location.reload()}>
                {t("updateNow")}
              </button>
            </>
          ) : null}
          {state === "error" ? (
            <>
              <p>{t("errorDetail")}</p>
              <button type="button" className="button-primary" onClick={retryNow}>
                {t("retry")}
              </button>
            </>
          ) : null}
          <p className="sync-last">{last}</p>
        </div>
      ) : null}
    </div>
  );
}

export type BannerActions = {
  onRestore?: (documentId: string) => void;
  onBack?: () => void;
  onHistory?: (documentId: string) => void;
  onExport?: () => void;
};

/** Bandeaux sobres : réunion (D-041), corbeille ailleurs (D-023), stockage plein (D-045, D-046). */
export function SyncBanners({ documentId, actions = {} }: { documentId?: string; actions?: BannerActions }) {
  const t = useTranslate("sync");
  const status = useSyncStatus();
  const visible = status.banners.filter((banner) => !("documentId" in banner) || banner.documentId === documentId);
  const persistent = visible.some((banner) => banner.kind === "offline-storage-full");

  useEffect(() => {
    if (!persistent) {
      return;
    }
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [persistent]);

  if (visible.length === 0) {
    return null;
  }
  return (
    <div className="sync-banners">
      {visible.map((banner) => (
        <BannerView key={`${banner.kind}-${"documentId" in banner ? banner.documentId : ""}`} banner={banner} actions={actions} t={t} />
      ))}
    </div>
  );
}

function BannerView({
  banner,
  actions,
  t,
}: {
  banner: Banner;
  actions: BannerActions;
  t: (key: string, options?: Record<string, string | number>) => string;
}) {
  const close = (
    <button type="button" className="banner-close" aria-label={t("close")} onClick={() => dismissBanner(banner)}>
      ×
    </button>
  );
  switch (banner.kind) {
    case "merged":
      return (
        <div className="banner" role="status">
          <p>{t("merged")}</p>
          {actions.onHistory ? (
            <button type="button" onClick={() => actions.onHistory?.(banner.documentId)}>
              {t("compare")}
            </button>
          ) : null}
          {close}
        </div>
      );
    case "trashed-elsewhere":
      return (
        <div className="banner" role="alert">
          <p>{t("trashedElsewhere")}</p>
          <button type="button" className="button-primary" onClick={() => actions.onRestore?.(banner.documentId)}>
            {t("restore")}
          </button>
          <button type="button" onClick={() => actions.onBack?.()}>
            {t("backToTexts")}
          </button>
        </div>
      );
    case "storage-full":
      return (
        <div className="banner" role="status">
          <p>{t("storageFull")}</p>
          {close}
        </div>
      );
    case "offline-storage-full":
      return (
        <div className="banner banner-amber" role="alert">
          <p>{t("offlineStorageFull")}</p>
          {actions.onExport ? (
            <button type="button" onClick={actions.onExport}>
              {t("exportCopy")}
            </button>
          ) : null}
        </div>
      );
  }
}
