import { CONTENT_FRAGMENT, META_MAP } from "@flaw/sync/src/index.ts";
import { useEffect, useState } from "react";
import * as Y from "yjs";

import { CSRF_HEADER, CSRF_VALUE } from "../auth-ui/api.ts";
import { useTranslate } from "../i18n/i18n.ts";
import { LOCAL_ONLY } from "../platform/target.ts";
import { listBeforeMerge, saveSnapshot } from "../sync-client/before-merge.ts";
import { useClosing } from "../shell/presence.ts";

type Version = {
  id: string;
  createdAt: string;
  reason: string;
  label: string | null;
  wordCount: number;
  local?: Uint8Array;
};

const DAY = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" });
const TIME = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });

function localText(update: Uint8Array): { text: string; words: number } {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  const text = doc
    .getXmlFragment(CONTENT_FRAGMENT)
    .toArray()
    .map((child) => child.toString().replace(/<[^>]*>/gu, ""))
    .join("\n");
  doc.destroy();
  const trimmed = text.trim();
  return { text, words: trimmed.length === 0 ? 0 : trimmed.split(/\s+/u).length };
}

/** Remplace le contenu du texte par celui d'un instantané : nouvelle modification CRDT. */
function restoreLocal(target: Y.Doc, update: Uint8Array): void {
  const source = new Y.Doc();
  Y.applyUpdate(source, update);
  const into = target.getXmlFragment(CONTENT_FRAGMENT);
  const from = source.getXmlFragment(CONTENT_FRAGMENT);
  target.transact(() => {
    into.delete(0, into.length);
    into.insert(0, from.toArray().map((child) => (child as Y.XmlElement | Y.XmlText).clone()));
    const meta = target.getMap<unknown>(META_MAP);
    source.getMap<unknown>(META_MAP).forEach((value, key) => meta.set(key, value));
  });
  source.destroy();
}

/**
 * Historique (D-038, D-039) : versions du serveur et instantanés de cet appareil
 * (avant réunion, avant changement de mode), groupés par jour ; aperçu, Restaurer,
 * point de sauvegarde manuel. Restaurer garde d'abord la version courante.
 */
export function History({ documentId, doc, onClose: closeNow }: { documentId: string; doc: Y.Doc | null; onClose: () => void }) {
  const t = useTranslate("editor");
  const { closing, close: onClose } = useClosing(closeNow);
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [preview, setPreview] = useState<{ version: Version; text: string } | null>(null);
  const [label, setLabel] = useState("");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const remote: Version[] = [];
      try {
        const response = LOCAL_ONLY ? null : await fetch(`/api/v1/documents/${documentId}/versions`, { credentials: "same-origin" });
        if (response?.ok) {
          remote.push(...((await response.json()) as { items: Version[] }).items);
        }
      } catch {
        // Hors ligne : seulement les instantanés de cet appareil.
      }
      const local = (await listBeforeMerge(documentId).catch(() => [])).map((row) => ({
        id: `local-${String(row.id)}`,
        createdAt: row.createdAt,
        reason: row.reason ?? "before_merge",
        label: row.label ?? null,
        wordCount: localText(row.update).words,
        local: row.update,
      }));
      if (alive) {
        setVersions([...remote, ...local].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)));
      }
    })();
    return () => {
      alive = false;
    };
  }, [documentId, tick]);

  const open = async (version: Version) => {
    if (version.local) {
      setPreview({ version, text: localText(version.local).text });
      return;
    }
    const response = await fetch(`/api/v1/documents/${documentId}/versions/${version.id}/preview`, { credentials: "same-origin" }).catch(() => null);
    setPreview({ version, text: response?.ok ? await response.text() : t("previewUnavailable") });
  };

  const restore = async (version: Version) => {
    if (version.local && doc) {
      // Avant restauration : on garde l'état courant comme instantané local.
      await saveSnapshot(documentId, Y.encodeStateAsUpdate(doc), "before_restore");
      restoreLocal(doc, version.local);
    } else {
      await fetch(`/api/v1/documents/${documentId}/versions/${version.id}/restore`, {
        method: "POST",
        headers: { [CSRF_HEADER]: CSRF_VALUE },
        credentials: "same-origin",
      }).catch(() => null);
    }
    setPreview(null);
    onClose();
  };

  const save = async () => {
    if (LOCAL_ONLY) {
      if (doc) {
        await saveSnapshot(documentId, Y.encodeStateAsUpdate(doc), "manual", label.trim() || null);
      }
      setLabel("");
      setTick((value) => value + 1);
      return;
    }
    await fetch(`/api/v1/documents/${documentId}/versions`, {
      method: "POST",
      headers: { "content-type": "application/json", [CSRF_HEADER]: CSRF_VALUE },
      body: JSON.stringify(label.trim() ? { label: label.trim() } : {}),
      credentials: "same-origin",
    }).catch(() => null);
    setLabel("");
    setTick((value) => value + 1);
  };

  const groups = new Map<string, Version[]>();
  for (const version of versions ?? []) {
    const key = DAY.format(new Date(version.createdAt));
    groups.set(key, [...(groups.get(key) ?? []), version]);
  }

  return (
    <aside className={`settings-panel history${closing ? " is-closing" : ""}`} aria-label={t("menu_history")}>
      <header className="settings-head">
        <strong>{t("menu_history")}</strong>
        <button type="button" className="icon-button" aria-label={t("close")} onClick={onClose}>
          ×
        </button>
      </header>
      <div className="settings-body">
        <p className="history-intro">{t("historyIntro")}</p>
        <p className="history-save-hint">{t("historySaveHint")}</p>
        <form
          className="history-save"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <input value={label} maxLength={120} placeholder={t("versionLabel")} aria-label={t("versionLabel")} onChange={(event) => setLabel(event.currentTarget.value)} />
          <button type="submit">{t("saveVersion")}</button>
        </form>
        {versions === null ? <p>{t("loading")}</p> : null}
        {versions?.length === 0 ? <p className="library-meta">{t("noVersions")}</p> : null}
        {[...groups.entries()].map(([day, items]) => (
          <section key={day}>
            <h3 className="library-heading">{day}</h3>
            <ul className="history-list">
              {items.map((version) => (
                <li key={version.id}>
                  <button type="button" className="history-item" onClick={() => void open(version)}>
                    <span>
                      {TIME.format(new Date(version.createdAt))} · {version.label ?? t(`reason_${version.reason}`)}
                    </span>
                    <span className="library-meta">{t("words", { count: version.wordCount })}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      {preview ? (
        <div className="dialog-veil" onClick={() => setPreview(null)}>
          <div className="dialog history-preview" role="dialog" aria-label={t("preview")} onClick={(event) => event.stopPropagation()}>
            <h2>
              {TIME.format(new Date(preview.version.createdAt))} · {preview.version.label ?? t(`reason_${preview.version.reason}`)}
            </h2>
            <pre>{preview.text}</pre>
            <div className="dialog-actions">
              <button type="button" onClick={() => setPreview(null)}>
                {t("cancel")}
              </button>
              <button type="button" className="button-primary" onClick={() => void restore(preview.version)}>
                {t("restoreVersion")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </aside>
  );
}
