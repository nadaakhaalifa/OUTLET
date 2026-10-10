import { MAX_FAVORITE_STORES } from "./store";

export interface FavoriteRow {
  readonly storeId: string;
  readonly position: number;
  readonly lastSeenAtMs: number;
}

export type ReplaceFavoritesError =
  | { readonly kind: "too_many_favorites"; readonly max: number }
  | { readonly kind: "duplicate_store" }
  | { readonly kind: "unknown_store" };

export type ReplaceFavoritesResult =
  | { readonly ok: true; readonly rows: readonly FavoriteRow[] }
  | { readonly ok: false; readonly error: ReplaceFavoritesError };

/**
 * Pure replace: validates the ordered id list against the visible store set and produces dense
 * positions. Retained stores keep last_seen_at; new ones start at `nowMs` (zero new items).
 */
export function replaceFavorites(
  current: readonly FavoriteRow[],
  requestedIds: readonly string[],
  isVisible: (storeId: string) => boolean,
  nowMs: number,
): ReplaceFavoritesResult {
  if (requestedIds.length > MAX_FAVORITE_STORES) {
    return { ok: false, error: { kind: "too_many_favorites", max: MAX_FAVORITE_STORES } };
  }
  if (new Set(requestedIds).size !== requestedIds.length) return { ok: false, error: { kind: "duplicate_store" } };
  for (const id of requestedIds) {
    if (!isVisible(id)) return { ok: false, error: { kind: "unknown_store" } };
  }
  const seen = new Map(current.map((r) => [r.storeId, r.lastSeenAtMs]));
  const rows = requestedIds.map((storeId, position) => ({
    storeId,
    position,
    lastSeenAtMs: seen.get(storeId) ?? nowMs,
  }));
  return { ok: true, rows };
}

/** last_seen_at never moves backwards (idempotent, clock-skew safe). */
export function advanceLastSeen(row: FavoriteRow, nowMs: number): FavoriteRow {
  return nowMs > row.lastSeenAtMs ? { ...row, lastSeenAtMs: nowMs } : row;
}

/** Count of activity strictly after the last visit. */
export function newSince(occurredAtMs: readonly number[], lastSeenAtMs: number): number {
  let n = 0;
  for (const t of occurredAtMs) if (t > lastSeenAtMs) n += 1;
  return n;
}
