import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";

import { KEYBOARD_CLEARANCE_PX, POINTER_WAKE_PX, isTypingKey, pointerWakesChrome } from "../layout/chrome.ts";

/** L'interface s'efface à la frappe et revient au mouvement du pointeur (D-101). */
export function useEditorChrome(): { hidden: boolean; onTyping: (event: KeyboardEvent) => void } {
  const [hidden, setHidden] = useState(false);
  const last = useRef<{ x: number; y: number } | null>(null);

  const onTyping = useCallback((event: KeyboardEvent) => {
    if (isTypingKey(event.key, { meta: event.metaKey, ctrl: event.ctrlKey, alt: event.altKey })) {
      setHidden(true);
    }
  }, []);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const previous = last.current;
      last.current = { x: event.clientX, y: event.clientY };
      if (previous !== null && pointerWakesChrome(event.clientX - previous.x, event.clientY - previous.y, POINTER_WAKE_PX)) {
        setHidden(false);
      }
    };
    window.addEventListener("pointermove", onMove);
    return () => {
      window.removeEventListener("pointermove", onMove);
    };
  }, []);

  return { hidden, onTyping };
}

export { KEYBOARD_CLEARANCE_PX };
