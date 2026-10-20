/**
 * Development hints registry (pure). Screens never render development notes; features register them here and
 * only the DevBadge sheet shows them, and only in a development build running on the in-memory fake backend.
 */
import type { BackendConfig } from "./release-guard";

export interface DevHint {
  readonly id: string;
  readonly text: string;
}

const hints = new Map<string, string>();
const listeners = new Set<() => void>();
let snapshot: readonly DevHint[] = [];
let notifyScheduled = false;

/**
 * Subscribers are never called synchronously: registration may happen while a component renders (a lazily
 * created port), and notifying a subscriber then would set state of another component mid-render. Notifications
 * are batched into one microtask.
 */
function scheduleNotify(): void {
  if (notifyScheduled) return;
  notifyScheduled = true;
  queueMicrotask(() => {
    notifyScheduled = false;
    [...listeners].forEach((l) => l());
  });
}

function isReleaseBuild(): boolean {
  return typeof __DEV__ !== "undefined" && !__DEV__;
}

/** Registers (or replaces) a development hint. A no-op in release builds, so no text ships to users. */
export function registerDevHint(id: string, text: string): void {
  if (isReleaseBuild()) return;
  if (hints.get(id) === text) return;
  hints.set(id, text);
  snapshot = [...hints.entries()].map(([k, v]) => ({ id: k, text: v }));
  scheduleNotify();
}

export function getDevHints(): readonly DevHint[] {
  return snapshot;
}

export function subscribeDevHints(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Test helper. */
export function clearDevHints(): void {
  hints.clear();
  snapshot = [];
  scheduleNotify();
}

/** The badge shows only in development, on the fake backend, and when not hidden for screenshots. */
export function isDevBadgeVisible(cfg: BackendConfig, isDev: boolean, hideFlag: string | undefined): boolean {
  return isDev && cfg.kind === "fixture" && hideFlag !== "1";
}
