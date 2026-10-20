import type { HistoryEvent, HistoryEventType, RecentlyViewed, UserFeatures } from "./bridge";

export interface IdPort {
  uuidV7(): string;
}
export interface Clock {
  nowMs(): number;
}

// ---- ports owned by other modules (fakes in adapters/in-memory.ts) ----------------------------

/** Consent core: is the `personalization` purpose currently granted. Withdrawal is honoured at once. */
export interface PersonalizationConsentPort {
  isGranted(userId: string): Promise<boolean>;
}

export interface ProductSnapshot {
  readonly productId: string;
  readonly storeId: string;
  readonly categoryId: string;
  readonly priceMinor: bigint;
  readonly storeActive: boolean;
}

/** Catalog module. The price is read server side; a client supplied price is never trusted. */
export interface ProductLookupPort {
  snapshot(productId: string): Promise<ProductSnapshot | null>;
}

/** kill.ml_ranking: true means ML ranking and feature building may run. Fails closed. */
export interface FlagPort {
  mlRankingAllowed(): Promise<boolean>;
}

// ---- events (outbox, same transaction as the state change) -----------------------------------

export type HistoryOutboxEvent =
  | { readonly type: "history.cleared"; readonly userId: string; readonly requestId: string; readonly deadlineMs: number }
  | { readonly type: "history.paused_changed"; readonly userId: string; readonly paused: boolean }
  | { readonly type: "personalization.changed"; readonly userId: string; readonly personalization: boolean };

export interface HistorySettings {
  readonly personalization: boolean;
  readonly historyPaused: boolean;
}

export const DEFAULT_SETTINGS: HistorySettings = { personalization: true, historyPaused: false };

export interface ClearRequest {
  readonly id: string;
  readonly userId: string;
  readonly requestedAtMs: number;
  readonly deadlineMs: number;
  readonly completedAtMs: number | null;
}

export interface EventPosition {
  readonly atMs: number;
  readonly id: string;
}

export interface StoredFeatures {
  readonly features: UserFeatures;
  readonly modelVersion: string;
}

export interface ClearCounts {
  readonly events: number;
  readonly features: number;
  readonly recentlyViewed: number;
}

export interface HistoryStore {
  /** Idempotent on the event id. */
  appendEvent(e: HistoryEvent): Promise<"recorded" | "duplicate">;
  listEvents(
    userId: string,
    type: HistoryEventType | null,
    after: EventPosition | null,
    limit: number,
  ): Promise<readonly HistoryEvent[]>;
  eventsSince(userId: string, sinceMs: number, limit: number): Promise<readonly HistoryEvent[]>;

  getSettings(userId: string): Promise<HistorySettings>;
  setPersonalization(userId: string, on: boolean, nowMs: number, events: readonly HistoryOutboxEvent[]): Promise<HistorySettings>;
  setPaused(userId: string, paused: boolean, nowMs: number, events: readonly HistoryOutboxEvent[]): Promise<HistorySettings>;

  getFeatures(userId: string): Promise<StoredFeatures | null>;
  putFeatures(userId: string, f: StoredFeatures): Promise<void>;
  deleteFeatures(userId: string): Promise<boolean>;

  upsertRecentlyViewed(userId: string, entry: RecentlyViewed, cap: number): Promise<void>;
  listRecentlyViewed(userId: string, limit: number): Promise<readonly RecentlyViewed[]>;

  /** One transaction: delete events, features and recently viewed, record the request, emit. */
  clearAll(input: {
    readonly requestId: string;
    readonly userId: string;
    readonly nowMs: number;
    readonly deadlineMs: number;
    readonly events: readonly HistoryOutboxEvent[];
  }): Promise<{ readonly request: ClearRequest; readonly counts: ClearCounts }>;
  pendingClearForUser(userId: string): Promise<readonly ClearRequest[]>;
  pendingClearRequests(limit: number): Promise<readonly ClearRequest[]>;
  /** Re-deletes anything at or before the request time (rebuilt by a batch) and completes it. */
  completeClear(requestId: string, nowMs: number): Promise<ClearCounts | null>;

  /** Retention: delete events strictly older than the cutoff. Returns the number removed. */
  purgeEventsBefore(cutoffMs: number, limit: number): Promise<number>;
  /** Users with events after `sinceMs` and personalization on (feature rebuild worklist). */
  usersWithRecentEvents(sinceMs: number, limit: number): Promise<readonly string[]>;
}
