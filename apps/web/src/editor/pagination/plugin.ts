import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey, type EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

import type { Geometry } from "./geometry.ts";
import { measureFromDom } from "./dom.ts";
import { createModel, integrate, measureChapter, type PaginationModel } from "./paginate.ts";

export const paginationKey = new PluginKey<PaginationModel>("flaw-pagination");

type Idle = (callback: () => void) => number;

function idle(): { request: Idle; cancel: (handle: number) => void } {
  const scope = globalThis as unknown as {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };
  if (scope.requestIdleCallback && scope.cancelIdleCallback) {
    const request = scope.requestIdleCallback.bind(globalThis);
    const cancel = scope.cancelIdleCallback.bind(globalThis);
    return { request: (callback) => request(callback, { timeout: 500 }), cancel };
  }
  return {
    request: (callback) => window.setTimeout(callback, 120),
    cancel: (handle) => {
      window.clearTimeout(handle);
    },
  };
}

/**
 * Pagination niveau 1 (T-016) : décorations mappées à la frappe, chapitre courant
 * remis en pages hors de la frappe, voisins ensuite ; les lointains restent estimés.
 */
export function paginationPlugin(geometry: Geometry): Plugin<PaginationModel> {
  return new Plugin<PaginationModel>({
    key: paginationKey,
    state: {
      init: (_config, state) => createModel(state.doc, geometry),
      apply(tr, previous) {
        const replacement = tr.getMeta(paginationKey) as PaginationModel | undefined;
        if (replacement !== undefined) {
          return replacement;
        }
        if (!tr.docChanged) {
          return previous;
        }
        return integrate(previous, tr);
      },
    },
    props: {
      decorations(state) {
        return paginationKey.getState(state)?.decorations ?? null;
      },
    },
    view(view) {
      if (!geometry.fluid) {
        return measuredView(view);
      }
      const { request, cancel } = idle();
      let handle: number | null = null;
      const queue = new Set<number>();
      const schedule = (): void => {
        if (handle !== null) {
          return;
        }
        handle = request(() => {
          handle = null;
          work(view);
        });
      };
      const work = (target: EditorView): void => {
        const model = paginationKey.getState(target.state);
        if (model === undefined) {
          return;
        }
        const next = queue.values().next();
        if (next.done) {
          return;
        }
        queue.delete(next.value);
        target.dispatch(
          target.state.tr.setMeta(paginationKey, measureChapter(model, target.state.doc, next.value)).setMeta("addToHistory", false),
        );
        if (queue.size > 0) {
          schedule();
        }
      };
      const enqueue = (state: EditorState): void => {
        const model = paginationKey.getState(state);
        if (model === undefined) {
          return;
        }
        // Saut lointain : le chapitre atteint est mis en pages à son tour (D-037).
        const pos = state.selection.from;
        const here = model.chapters.find((chapter) => pos >= chapter.from && pos <= chapter.to);
        if (here !== undefined && here.status !== "measured") {
          queue.add(here.index);
          schedule();
        }
        if (model.dirtyChapter === null) {
          return;
        }
        // Chapitre courant, puis ses voisins : le saut proche reste juste.
        for (const index of [model.dirtyChapter, model.dirtyChapter - 1, model.dirtyChapter + 1]) {
          const chapter = model.chapters[index];
          if (chapter !== undefined && (index === model.dirtyChapter || chapter.status !== "measured")) {
            queue.add(index);
          }
        }
        schedule();
      };
      enqueue(view.state);
      return {
        update(updated, previous) {
          if (updated.state.doc !== previous.doc || updated.state.selection !== previous.selection) {
            enqueue(updated.state);
          }
        },
        destroy() {
          if (handle !== null) {
            cancel(handle);
          }
        },
      };
    },
  });
}

/** Délai de calme avant de remettre en pages (la frappe n'attend jamais la mesure). */
const MEASURE_DELAY_MS = 350;

/** Pages mesurées sur le rendu réel : remises en pages après chaque pause de frappe. */
function measuredView(view: EditorView) {
  let timer: number | null = null;
  const run = (): void => {
    timer = null;
    const model = paginationKey.getState(view.state);
    // En mode focus la colonne est réduite : on remesure à la sortie (changement de largeur).
    if (model === undefined || view.isDestroyed || view.dom.closest('[data-focus="true"]') !== null) {
      return;
    }
    const next = measureFromDom(view, model);
    if (next !== null) {
      view.dispatch(view.state.tr.setMeta(paginationKey, next).setMeta("addToHistory", false));
    }
  };
  const schedule = (delay = MEASURE_DELAY_MS): void => {
    if (timer !== null) {
      window.clearTimeout(timer);
    }
    timer = window.setTimeout(run, delay);
  };
  // Largeur, police ou taille changées : on remesure aussi.
  let width = view.dom.getBoundingClientRect().width;
  const observer = new ResizeObserver(() => {
    const current = view.dom.getBoundingClientRect().width;
    if (current !== width) {
      width = current;
      schedule(120);
    }
  });
  observer.observe(view.dom);
  const book = view.dom.closest(".book");
  const styles = new MutationObserver(() => schedule(120));
  if (book !== null) {
    styles.observe(book, { attributes: true, attributeFilter: ["style", "data-format", "data-mode"] });
  }
  schedule(0);
  void document.fonts.ready.then(() => schedule(0));
  return {
    update(updated: EditorView, previous: EditorState) {
      if (updated.state.doc !== previous.doc) {
        schedule();
      }
    },
    destroy() {
      if (timer !== null) {
        window.clearTimeout(timer);
      }
      observer.disconnect();
      styles.disconnect();
    },
  };
}

export function paginationOf(state: EditorState): PaginationModel | undefined {
  return paginationKey.getState(state);
}

export type { PMNode };
