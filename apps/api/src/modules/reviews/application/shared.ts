import {
  decodeCursor,
  encodeCursor,
  reviewerInitial,
  type KeysetPosition,
  type ReviewRulesConfig,
} from "../domain/bridge";
import type { Clock, IdPort, KeysetPage, ReviewStore, ReviewerProfilePort } from "../domain/ports";

export interface ReviewDeps {
  readonly store: ReviewStore;
  readonly clock: Clock;
  readonly ids: IdPort;
  readonly cfg: ReviewRulesConfig;
}

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 50;

export type PageOutcome<T> =
  | { readonly kind: "ok"; readonly items: readonly T[]; readonly nextCursor: string | null }
  | { readonly kind: "invalid_cursor" };

/** Reads limit + 1 rows to know whether another page exists; the cursor is the last returned key. */
export async function keyset<T>(
  cursor: string | null,
  limit: number,
  fetch: (page: KeysetPage) => Promise<readonly T[]>,
  key: (t: T) => KeysetPosition,
): Promise<PageOutcome<T>> {
  let after: KeysetPosition | null = null;
  if (cursor !== null) {
    after = decodeCursor(cursor);
    if (after === null) return { kind: "invalid_cursor" };
  }
  const size = Math.min(Math.max(1, Math.trunc(limit)), MAX_PAGE_LIMIT);
  const rows = await fetch({ after, limit: size + 1 });
  const items = rows.slice(0, size);
  const last = items[items.length - 1];
  const more = rows.length > size && last !== undefined;
  return { kind: "ok", items, nextCursor: more ? encodeCursor(key(last)) : null };
}

/** Public display name: the initial of the first name or nothing. Never an id or a full name. */
export async function initialOf(profiles: ReviewerProfilePort, userId: string): Promise<string | null> {
  return reviewerInitial(await profiles.firstName(userId));
}

export const iso = (ms: number): string => new Date(ms).toISOString();
