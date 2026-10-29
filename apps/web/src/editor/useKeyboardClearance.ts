import { useEffect, type RefObject } from "react";
import type { EditorView } from "prosemirror-view";

import { KEYBOARD_CLEARANCE_PX } from "../layout/chrome.ts";

/**
 * Clavier mobile (AC-052, D-027) : la ligne en cours reste au-dessus du clavier.
 * visualViewport donne la zone visible ; on fait défiler si le curseur passe dessous.
 */
export function useKeyboardClearance(viewRef: RefObject<EditorView | null>): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) {
      return;
    }
    let frame = 0;
    const check = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const view = viewRef.current;
        if (!view || !view.hasFocus()) {
          return;
        }
        let caret: { top: number; bottom: number };
        try {
          caret = view.coordsAtPos(view.state.selection.head);
        } catch {
          return;
        }
        const visibleBottom = viewport.offsetTop + viewport.height - KEYBOARD_CLEARANCE_PX;
        const visibleTop = viewport.offsetTop + KEYBOARD_CLEARANCE_PX;
        if (caret.bottom > visibleBottom) {
          window.scrollBy({ top: caret.bottom - visibleBottom });
        } else if (caret.top < visibleTop) {
          window.scrollBy({ top: caret.top - visibleTop });
        }
      });
    };
    viewport.addEventListener("resize", check);
    viewport.addEventListener("scroll", check);
    window.document.addEventListener("selectionchange", check);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", check);
      viewport.removeEventListener("scroll", check);
      window.document.removeEventListener("selectionchange", check);
    };
  }, [viewRef]);
}
