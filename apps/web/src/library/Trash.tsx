import { useEffect, useRef, useState } from "react";

import { useTranslate } from "../i18n/i18n.ts";
import type { LocalDocument, LocalStore } from "../local-store/index.ts";
import { MODE_FONT } from "./formats-by-mode.ts";
import { navigate } from "./route.ts";

const TRASH_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export function daysLeft(deletedAt: string, now = Date.now()): number {
  return Math.max(0, TRASH_DAYS - Math.floor((now - new Date(deletedAt).getTime()) / DAY_MS));
}

/** Corbeille (D-021) : jours restants, Restaurer, Supprimer définitivement, Vider la corbeille. */
export function Trash({ store }: { store: LocalStore }) {
  const t = useTranslate("library");
  const [items, setItems] = useState<LocalDocument[] | null>(null);
  const [confirm, setConfirm] = useState<{ ids: string[]; title: string } | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      void store.listTrash().then((list) => {
        if (alive) {
          setItems(list);
        }
      });
    };
    load();
    const unsubscribe = store.subscribe(load);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [store]);

  const erase = async (ids: string[]) => {
    for (const id of ids) {
      const request = await store.requestPermanentDelete(id);
      await store.confirmPermanentDelete(id, request.confirmationId);
    }
  };

  return (
    <div className="library">
      <header className="library-bar">
        <button type="button" onClick={() => navigate({ name: "list" })}>
          ← {t("backToList")}
        </button>
        {items !== null && items.length > 0 ? (
          <button
            type="button"
            className="button-danger"
            onClick={() => setConfirm({ ids: items.map((item) => item.id), title: t("trashAll") })}
          >
            {t("emptyTrash")}
          </button>
        ) : null}
      </header>
      <section className="library-list">
        <h1 className="library-heading">
          {t("trashHeading")} <span>— {t("trashNote")}</span>
        </h1>
        {items !== null && items.length === 0 ? <p className="library-meta">{t("trashEmpty")}</p> : null}
        <ul>
          {(items ?? []).map((doc) => (
            <li key={doc.id} className="library-row trash-row">
              <div className="library-open">
                <span className="library-title" style={{ fontFamily: MODE_FONT[doc.mode] }}>
                  {doc.title || t("untitled")}
                </span>
                <span className="library-meta">{t("daysLeft", { count: doc.deletedAt ? daysLeft(doc.deletedAt) : TRASH_DAYS })}</span>
              </div>
              <div className="trash-actions">
                <button type="button" onClick={() => void store.restoreDocument(doc.id)}>
                  {t("restore")}
                </button>
                <button type="button" className="danger-link" onClick={() => setConfirm({ ids: [doc.id], title: doc.title || t("untitled") })}>
                  {t("deleteForever")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>
      {confirm ? (
        <ConfirmErase
          title={confirm.title}
          many={confirm.ids.length > 1}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const ids = confirm.ids;
            setConfirm(null);
            void erase(ids).catch(() => undefined);
          }}
        />
      ) : null}
    </div>
  );
}

/** Seule action irréversible (D-022) : focus par défaut sur Annuler. */
function ConfirmErase({ title, many, onCancel, onConfirm }: { title: string; many: boolean; onCancel: () => void; onConfirm: () => void }) {
  const t = useTranslate("library");
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancel.current?.focus();
  }, []);
  return (
    <div className="dialog-veil" onClick={onCancel}>
      <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="erase-title" onClick={(event) => event.stopPropagation()}>
        <h2 id="erase-title">{many ? t("eraseAllTitle") : t("eraseTitle", { title })}</h2>
        <p>{t("eraseBody")}</p>
        <div className="dialog-actions">
          <button ref={cancel} type="button" onClick={onCancel}>
            {t("cancel")}
          </button>
          <button type="button" className="button-danger" onClick={onConfirm}>
            {t("deleteForever")}
          </button>
        </div>
      </div>
    </div>
  );
}
