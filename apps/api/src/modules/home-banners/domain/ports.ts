import type { HomeBanner } from "./banner";

/** Kill switch key (ADR-0028 polarity: allowed-when-true, default blocked in production). */
export const FLAG_HOME_BANNERS = "kill.home_banners";

export interface HomeBannerStore {
  insert(b: HomeBanner): Promise<void>;
  get(id: string): Promise<HomeBanner | null>;
  /** Compare-and-set on `version`; the stored row becomes `next` with version + 1. null when stale or gone. */
  replace(next: HomeBanner, expectedVersion: number): Promise<HomeBanner | null>;
  remove(id: string): Promise<boolean>;
  /** Admin list, newest first. */
  list(limit: number): Promise<readonly HomeBanner[]>;
  /** Scheduled rows whose window contains `nowMs` (SERVER time), at most `limit`. */
  listScheduledAt(nowMs: number, limit: number): Promise<readonly HomeBanner[]>;
}

export interface BannerFlagPort {
  isEnabled(key: string): boolean | Promise<boolean>;
}

/** Hash-chained admin audit sink. A failure fails the action (closed); the write is never attempted. */
export interface BannerAuditEntry {
  readonly action: string;
  readonly actorId: string | null;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly reasonCode: string | null;
  /** Ids, states, counts and field NAMES only. Never text values. */
  readonly diff: Readonly<Record<string, string | number | boolean | null>>;
  readonly requestId: string | null;
  readonly atMs: number;
}
export interface BannerAuditPort {
  append(e: BannerAuditEntry): Promise<void>;
}

/** Turns a stored object-store key into a short-lived, read-only URL. null: no media base is configured (image omitted). */
export interface BannerImageUrlPort {
  urlFor(key: string, nowMs: number): string | null;
}
