import type { HistoryEvent, RecentlyViewed } from "./types";

export const HOUR_MS = 3_600_000;
/** Clear history must wipe user_events and derived features within 24 hours (spec 13). */
export const CLEAR_DEADLINE_MS = 24 * HOUR_MS;
export const HISTORY_RETENTION_MONTHS = 25;
export const RECENTLY_VIEWED_CAP = 50;
export const DETAIL_MAX = 120;

export type RecordDecision = "record" | "drop_paused";

/** Pause means no new events are recorded at all (not recorded and hidden: not recorded). */
export function recordDecision(historyPaused: boolean): RecordDecision {
  return historyPaused ? "drop_paused" : "record";
}

export function clearDeadline(requestedAtMs: number): number {
  return requestedAtMs + CLEAR_DEADLINE_MS;
}

export function isClearOverdue(deadlineMs: number, completedAtMs: number | null, nowMs: number): boolean {
  return completedAtMs === null && nowMs > deadlineMs;
}

/** Events older than this are aggregated and removed (analytics retention, 25 months). */
export function retentionCutoffMs(nowMs: number): number {
  const d = new Date(nowMs);
  d.setUTCMonth(d.getUTCMonth() - HISTORY_RETENTION_MONTHS);
  return d.getTime();
}

/** Control characters stripped, whitespace collapsed, capped. Null when nothing is left. */
export function normalizeDetail(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  // eslint-disable-next-line no-control-regex
  const t = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (t.length === 0) return null;
  return t.length > DETAIL_MAX ? t.slice(0, DETAIL_MAX) : t;
}

/** Most recent first, one row per product, capped. Pure: returns a new list. */
export function upsertRecentlyViewed(
  list: readonly RecentlyViewed[],
  entry: RecentlyViewed,
  cap: number = RECENTLY_VIEWED_CAP,
): readonly RecentlyViewed[] {
  const rest = list.filter((r) => r.productId !== entry.productId);
  return [entry, ...rest].sort((a, b) => b.viewedAtMs - a.viewedAtMs).slice(0, Math.max(1, cap));
}

export function isHistoryEventOlderThanRetention(e: Pick<HistoryEvent, "atMs">, nowMs: number): boolean {
  return e.atMs < retentionCutoffMs(nowMs);
}
