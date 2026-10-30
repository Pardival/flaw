import { useSyncExternalStore } from "react";

import { CSRF_HEADER, CSRF_VALUE } from "../auth-ui/api.ts";
import { LOCAL_ONLY } from "../platform/target.ts";

/**
 * Objectif quotidien (R-016, AC-056) : mots ajoutés nets, tous textes et appareils,
 * remis à zéro à minuit heure de l'appareil. Chaque appareil publie son compteur du
 * jour (G-Counter, fusion par maximum) ; le total = autres appareils + cet appareil.
 */
const DEVICE_KEY = "flaw.deviceId";
const COUNTER_PREFIX = "flaw.daily.";
const PUBLISH_DELAY_MS = 5_000;

type State = { day: string; mine: number; others: number; goal: number | null };

function today(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function deviceId(): string {
  const store = storage();
  const existing = store?.getItem(DEVICE_KEY);
  if (existing) {
    return existing;
  }
  const id = crypto.randomUUID();
  store?.setItem(DEVICE_KEY, id);
  return id;
}

function readMine(day: string): number {
  const value = Number(storage()?.getItem(COUNTER_PREFIX + day) ?? "0");
  return Number.isFinite(value) && value > 0 ? value : 0;
}

let state: State = { day: today(), mine: readMine(today()), others: 0, goal: null };
let published = 0;
let timer: number | undefined;
const listeners = new Set<() => void>();

function emit(next: State): void {
  state = next;
  for (const listener of listeners) {
    listener();
  }
}

function rollover(): void {
  const day = today();
  if (day !== state.day) {
    published = 0;
    emit({ day, mine: readMine(day), others: 0, goal: state.goal });
  }
}

async function publish(): Promise<void> {
  const { day, mine } = state;
  if (LOCAL_ONLY || !navigator.onLine) {
    return;
  }
  const response = await fetch(`/api/v1/stats/daily/${day}/devices/${deviceId()}`, {
    method: "PUT",
    headers: { "content-type": "application/json", [CSRF_HEADER]: CSRF_VALUE },
    body: JSON.stringify({ wordsWritten: mine }),
    credentials: "same-origin",
  }).catch(() => null);
  if (response?.ok) {
    published = mine;
  }
}

/** Relit le total du jour (autres appareils). */
export async function refreshDaily(): Promise<void> {
  rollover();
  if (LOCAL_ONLY) {
    return;
  }
  const day = state.day;
  const response = await fetch(`/api/v1/stats/daily?from=${day}&to=${day}`, { credentials: "same-origin" }).catch(() => null);
  if (!response?.ok) {
    return;
  }
  const body = (await response.json()) as { goal?: number; days?: Array<{ day: string; wordsWritten: number }> };
  const total = body.days?.find((item) => item.day === day)?.wordsWritten ?? 0;
  emit({ ...state, others: Math.max(0, total - published), goal: typeof body.goal === "number" ? body.goal : state.goal });
}

/** Mots ajoutés (ou retirés) dans un texte : le compteur du jour suit le net, sans descendre sous zéro. */
export function recordWords(delta: number): void {
  if (delta === 0) {
    return;
  }
  rollover();
  const mine = Math.max(0, state.mine + delta);
  storage()?.setItem(COUNTER_PREFIX + state.day, String(mine));
  emit({ ...state, mine });
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    void publish();
  }, PUBLISH_DELAY_MS);
}

export function useDaily(): { words: number; goal: number | null } {
  const snapshot = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => state,
  );
  return { words: snapshot.mine + snapshot.others, goal: snapshot.goal };
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    void publish().then(refreshDaily);
  });
  window.setInterval(() => {
    rollover();
  }, 60_000);
}
