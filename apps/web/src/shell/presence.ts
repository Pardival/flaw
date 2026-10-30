import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Sorties animées : un élément qui se ferme reste affiché le temps de son
 * animation de sortie (classe `is-closing`), symétrique de l'ouverture.
 */
export const EXIT_MS = 170;

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/** Pour un élément affiché selon `open` (menus) : reste monté pendant la sortie. */
export function usePresence(open: boolean, ms = EXIT_MS): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const timer = window.setTimeout(() => setMounted(false), reducedMotion() ? 0 : ms);
    return () => window.clearTimeout(timer);
  }, [open, ms]);
  return { mounted: open || mounted, closing: !open && mounted };
}

/** Pour un panneau retiré par son parent : `close()` joue la sortie puis appelle `onClose`. */
export function useClosing(onClose: () => void, ms = EXIT_MS): { closing: boolean; close: () => void } {
  const [closing, setClosing] = useState(false);
  const latest = useRef(onClose);
  latest.current = onClose;
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const close = useCallback(() => {
    if (timer.current !== undefined) return;
    if (reducedMotion()) {
      latest.current();
      return;
    }
    setClosing(true);
    timer.current = window.setTimeout(() => latest.current(), ms);
  }, [ms]);
  return { closing, close };
}

/** Change d'écran avec un fondu enchaîné natif quand le moteur le permet. */
export function withViewTransition(update: () => void): void {
  const doc = document as Document & { startViewTransition?: (callback: () => void) => unknown };
  if (typeof doc.startViewTransition !== "function" || reducedMotion() || document.hidden) {
    update();
    return;
  }
  // Le moteur appelle `update` à la prochaine image ; si elle ne vient pas (fenêtre
  // en arrière-plan), l'écran change quand même, une seule fois.
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    update();
  };
  try {
    doc.startViewTransition(run);
  } catch {
    run();
  }
  window.setTimeout(run, 150);
}
