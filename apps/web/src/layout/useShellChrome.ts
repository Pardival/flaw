import { useEffect, useState } from "react";

import {
  KEYBOARD_CLEARANCE_PX,
  POINTER_WAKE_PX,
  chromeStaysHidden,
  isTypingKey,
  keyboardClosed,
  pointerWakesChrome,
  revealDelta,
  scrolledUp,
  shouldHideChromeOnKey,
  type PageMode,
} from "./chrome.ts";

function scrollTopOf(target: EventTarget | null): number {
  if (target instanceof HTMLElement) {
    return target.scrollTop;
  }
  return window.scrollY;
}

export function useShellChrome(mode: PageMode, pageFocused: boolean): boolean {
  const [hidden, setHidden] = useState(() => chromeStaysHidden(mode, pageFocused));

  useEffect(() => {
    if (chromeStaysHidden(mode, pageFocused)) {
      setHidden(true);
    }
  }, [mode, pageFocused]);

  useEffect(() => {
    let lastX = 0;
    let lastY = 0;
    let hasPointer = false;
    let lastViewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const lastTops = new WeakMap<object, number>();

    function show(): void {
      if (chromeStaysHidden(mode, pageFocused)) {
        return;
      }
      setHidden(false);
    }

    function onKeyDown(event: KeyboardEvent): void {
      const target = event.target;
      const chrome = document.querySelector("[data-chrome]");
      const targetIsChrome = target instanceof Node && chrome !== null && chrome.contains(target);
      const typing = isTypingKey(event.key, { meta: event.metaKey, ctrl: event.ctrlKey, alt: event.altKey });
      if (shouldHideChromeOnKey(typing, targetIsChrome, chromeStaysHidden(mode, pageFocused))) {
        setHidden(true);
      }
    }

    function onPointerMove(event: PointerEvent): void {
      if (!hasPointer) {
        lastX = event.clientX;
        lastY = event.clientY;
        hasPointer = true;
        return;
      }
      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      if (pointerWakesChrome(dx, dy, POINTER_WAKE_PX)) {
        show();
      }
    }

    function onPointerDown(event: PointerEvent): void {
      const page = document.querySelector(".page");
      if (page !== null && event.target instanceof Node && !page.contains(event.target)) {
        show();
      }
    }

    function onScroll(event: Event): void {
      const target = event.target;
      if (target === null || typeof target !== "object") {
        return;
      }
      const next = scrollTopOf(target);
      const previous = lastTops.get(target);
      lastTops.set(target, next);
      if (previous !== undefined && scrolledUp(previous, next)) {
        show();
      }
    }

    function onViewport(): void {
      const next = window.visualViewport?.height ?? window.innerHeight;
      if (keyboardClosed(lastViewportHeight, next)) {
        show();
      }
      lastViewportHeight = next;
    }

    function onFocusIn(event: FocusEvent): void {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      const chrome = document.querySelector("[data-chrome]");
      if (chrome !== null && chrome.contains(target)) {
        show();
      }
      // L'éditeur occupe tout le livre : c'est son curseur qu'il faut dégager (useKeyboardClearance).
      if (target.isContentEditable) {
        return;
      }
      const viewport = window.visualViewport;
      if (viewport === null) {
        target.scrollIntoView({ block: "nearest" });
        return;
      }
      const delta = revealDelta(
        target.getBoundingClientRect().bottom,
        viewport.offsetTop,
        viewport.height,
        KEYBOARD_CLEARANCE_PX,
      );
      if (delta > 0) {
        window.scrollBy(0, delta);
      }
    }

    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.visualViewport?.addEventListener("resize", onViewport);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("scroll", onScroll, { capture: true });
      window.visualViewport?.removeEventListener("resize", onViewport);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [mode, pageFocused]);

  return hidden;
}
