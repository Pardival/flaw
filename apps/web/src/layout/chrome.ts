/** Règles d'apparition du chrome (D-101), sans les appliquer aux champs d'auth. */

export const PAGE_MODES = ["novel", "screenplay", "document", "blank"] as const;

export type PageMode = (typeof PAGE_MODES)[number];

export const KEYBOARD_CLEARANCE_PX = 24;

export function chromeStaysHidden(mode: PageMode, pageFocused: boolean): boolean {
  return mode === "blank" && pageFocused;
}

export function isTypingKey(key: string, modifiers: { meta: boolean; ctrl: boolean; alt: boolean }): boolean {
  if (modifiers.meta || modifiers.ctrl || modifiers.alt) {
    return false;
  }
  return key.length === 1 || key === "Backspace" || key === "Enter";
}

export function shouldHideChromeOnKey(typing: boolean, targetIsChrome: boolean, blankFocused: boolean): boolean {
  if (blankFocused) {
    return true;
  }
  return typing && !targetIsChrome;
}

export function pointerWakesChrome(dx: number, dy: number, thresholdPx: number): boolean {
  return Math.hypot(dx, dy) > thresholdPx;
}

export function keyboardClosed(previousHeight: number, nextHeight: number): boolean {
  return nextHeight > previousHeight;
}

export function scrolledUp(previousTop: number, nextTop: number): boolean {
  return nextTop < previousTop;
}

/** Pixels à défiler pour garder le bas de la ligne au-dessus du clavier. */
export function revealDelta(
  rectBottom: number,
  viewportOffsetTop: number,
  viewportHeight: number,
  marginPx: number,
): number {
  const limit = viewportOffsetTop + viewportHeight - marginPx;
  const delta = rectBottom - limit;
  return delta > 0 ? delta : 0;
}
