import type { Drop, DropState } from "./bridge";

export interface Clock {
  nowMs(): number;
}
export interface IdPort {
  uuidV7(): string;
}

// ---- events (outbox, same transaction as the state change) -----------------------------------

export type DropOutboxEvent =
  | { readonly type: "drop.scheduled"; readonly dropId: string; readonly storeId: string; readonly startsAtMs: number }
  | { readonly type: "drop.early_access_opened"; readonly dropId: string; readonly storeId: string }
  | { readonly type: "drop.live"; readonly dropId: string; readonly storeId: string }
  | { readonly type: "drop.sold_out"; readonly dropId: string; readonly storeId: string }
  | { readonly type: "drop.ended"; readonly dropId: string; readonly storeId: string; readonly reason: "window" | "admin" }
  | { readonly type: "drop.cancelled"; readonly dropId: string; readonly storeId: string }
  | { readonly type: "drop.paused"; readonly dropId: string; readonly storeId: string; readonly paused: boolean }
  | { readonly type: "drop.waitlist_joined"; readonly dropId: string; readonly userId: string }
  | { readonly type: "drop.units_claimed"; readonly dropId: string; readonly skuId: string; readonly qty: number };

export interface PurchaseRecord {
  readonly reservationId: string;
  readonly dropId: string;
  readonly skuId: string;
  readonly userId: string;
  readonly deviceHash: string;
  readonly qty: number;
  readonly createdAtMs: number;
}

export interface KeysetPosition {
  readonly startsAtMs: number;
  readonly id: string;
}

export type SaveResult = "ok" | "conflict" | "not_found";

export interface DropStore {
  insert(d: Drop, events: readonly DropOutboxEvent[]): Promise<void>;
  get(id: string): Promise<Drop | null>;
  /** Optimistic: writes every field and replaces the items iff the stored version is `expectedVersion`. */
  save(next: Drop, expectedVersion: number, events: readonly DropOutboxEvent[]): Promise<SaveResult>;
  /** Only a DRAFT can be deleted. */
  removeDraft(id: string): Promise<boolean>;
  listPublic(after: KeysetPosition | null, limit: number): Promise<readonly Drop[]>;
  listByStores(storeIds: readonly string[], after: KeysetPosition | null, limit: number): Promise<readonly Drop[]>;
  /** SCHEDULED, EARLY_ACCESS, LIVE: what the sweepers walk. */
  active(): Promise<readonly Drop[]>;
  addWaitlist(dropId: string, userId: string, nowMs: number, events: readonly DropOutboxEvent[]): Promise<"added" | "exists">;
  waitlistSize(dropId: string): Promise<number>;
  purchased(dropId: string, skuId: string, userId: string, deviceHash: string): Promise<{ byUser: number; byDevice: number }>;
  recordPurchase(p: PurchaseRecord, events: readonly DropOutboxEvent[]): Promise<"recorded" | "exists">;
  releasePurchase(reservationId: string, nowMs: number): Promise<PurchaseRecord | null>;
  /** Real units bought (not released) since a time, for truthful social proof. */
  boughtSince(dropId: string, sinceMs: number): Promise<number>;
}

// ---- ports owned by other modules ------------------------------------------------------------

export interface UnitsSnapshot {
  readonly cap: number;
  readonly available: number;
  readonly reserved: number;
  readonly claimed: number;
}

/** Inventory module (ADR-0005 row-per-unit pool). The drop's stock cap bounds what it may hand out. */
export interface DropInventoryPort {
  setCap(dropId: string, skuId: string, cap: number): Promise<void>;
  /** All or nothing for one line. `available` is what was left when it failed. */
  reserve(i: {
    readonly dropId: string;
    readonly skuId: string;
    readonly qty: number;
    readonly reservationId: string;
    readonly expiresAtMs: number;
  }): Promise<{ readonly ok: true } | { readonly ok: false; readonly available: number }>;
  release(reservationId: string): Promise<void>;
  claim(reservationId: string): Promise<boolean>;
  snapshot(dropId: string, skuId: string): Promise<UnitsSnapshot>;
  /** Returns expired reservations to the pool; reports their ids. */
  sweepExpired(nowMs: number): Promise<readonly string[]>;
  /** Drop ended or cancelled: free the unreserved pool, keep reserved and claimed units. */
  closeDrop(dropId: string): Promise<void>;
}

/** "Definitely sold out" pre-filter (Redis, short TTL). Never the source of truth. */
export interface SoldOutFlagPort {
  mark(dropId: string, ttlMs: number): Promise<void>;
  clear(dropId: string): Promise<void>;
  isSoldOut(dropId: string): Promise<boolean>;
}

/** Analytics: real "viewing now" count from live events. null when the signal is unavailable. */
export interface SocialSignalsPort {
  viewingNow(dropId: string): Promise<number | null>;
}

export type SwitchKey = "drops_all" | "mystery_box" | `drop_type_${string}`;
export interface SwitchPort {
  allowed(key: SwitchKey): Promise<boolean>;
}

/** The waiting-room module's AdmissionVerifier, seen structurally. */
export interface AdmissionVerifierPort {
  verify(i: { token: string; dropId: string; userId: string; deviceId: string }): Promise<
    { readonly ok: true; readonly claims: { readonly jti: string } } | { readonly ok: false; readonly code: string }
  >;
  consume(jti: string): Promise<"used" | "already_used" | "unknown" | "expired">;
}

export const ACTIVE_STATES: readonly DropState[] = ["SCHEDULED", "EARLY_ACCESS", "LIVE"];

/** Stored waiting-room counters (the waiting-room module's WaitingRoomOpsCounters, seen structurally). */
export interface DropOpsSource {
  /** null = the queue backend could not be read (unmeasured). */
  queueDepth(dropId: string): Promise<number | null>;
  windowCounts(dropId: string, windowMs: number): Promise<{ readonly admitted: number; readonly rejected: number; readonly abandoned: number }>;
}
