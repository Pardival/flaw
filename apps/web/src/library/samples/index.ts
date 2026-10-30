import { documentFromJson } from "@flaw/schema/src/index.ts";
import { prosemirrorToYXmlFragment } from "y-prosemirror";

import { PROSEMIRROR_FRAGMENT, type DocumentMode, type LocalStore } from "../../local-store/index.ts";
import { defaultFormat } from "../formats-by-mode.ts";

/**
 * Textes d'exemple (démo de l'accueil vide) : une histoire par mode, sur ce que
 * l'être humain comprend mal de lui-même. Chargés à la demande, hors du paquet principal.
 */
const SAMPLES: readonly { mode: DocumentMode; title: string; load: () => Promise<{ default: unknown }> }[] = [
  { mode: "novel", title: "Le Cartographe des oublis", load: () => import("./novel.json") },
  { mode: "screenplay", title: "Angle mort", load: () => import("./screenplay.json") },
  { mode: "blank", title: "Lettres à celle que je serai", load: () => import("./blank.json") },
  { mode: "document", title: "Pourquoi nous nous connaissons si mal", load: () => import("./document.json") },
];

/** Crée les quatre textes d'exemple, comme le ferait un import. */
export async function loadSamples(store: LocalStore): Promise<void> {
  for (const sample of SAMPLES) {
    const json = (await sample.load()).default;
    const node = documentFromJson(json);
    const doc = await store.createDocument({ mode: sample.mode, pageFormat: defaultFormat(sample.mode), title: sample.title });
    const ydoc = await store.openDocument(doc.id);
    const fragment = ydoc.getXmlFragment(PROSEMIRROR_FRAGMENT);
    if (fragment.length === 0) {
      ydoc.transact(() => {
        prosemirrorToYXmlFragment(node, fragment);
      });
    }
    await store.captureEdits(doc.id);
  }
}
