import type { ReservationStatus, Shortfall } from "./types";
import type { StockMode, StockReason } from "./sync";

export type ReserveOutcome =
  | { readonly status: "reserved"; readonly reservationId: string; readonly expiresAtMs: number; readonly replayed: boolean }
  | { readonly status: "insufficient"; readonly shortfalls: readonly Shortfall[] }
  /** Same order group, different lines. */
  | { readonly status: "conflict" }
  /** Same order group and lines, but the reservation is no longer ACTIVE. */
  | { readonly status: "closed"; readonly reservationStatus: ReservationStatus };

export type ClaimOutcome =
  | { readonly status: "claimed" }
  /** Reservation had lapsed; stock was still free and was claimed directly (spec 7 edge case). */
  | { readonly status: "claimed_late" }
  | { readonly status: "already_claimed" }
  /** Lapsed and no stock left: the saga must refund automatically. */
  | { readonly status: "unavailable"; readonly shortfalls: readonly Shortfall[] }
  | { readonly status: "not_found" };

export type ReleaseReason = "payment_failed" | "cancelled" | "abandoned" | "expired";

export type ReleaseOutcome =
  | { readonly status: "released" }
  | { readonly status: "noop"; readonly reservationStatus: ReservationStatus }
  | { readonly status: "not_found" };

export type UnclaimOutcome =
  | { readonly status: "unclaimed" }
  | { readonly status: "noop"; readonly reservationStatus: ReservationStatus }
  | { readonly status: "not_found" };

export interface SweepResult {
  readonly expiredReservations: number;
  readonly releasedUnits: number;
}

export interface LevelView {
  readonly skuId: string;
  readonly onHand: number;
  readonly committed: number;
  readonly reserved: number;
  readonly available: number;
  readonly syncVersion: number;
  readonly updatedAtMs: number;
}

export interface SyncCommand {
  readonly skuId: string;
  readonly locationId: string;
  readonly poolId: string;
  readonly storeId: string;
  readonly mode: StockMode;
  readonly quantity: number;
  readonly reason: StockReason;
  readonly idempotencyKey: string;
  readonly expectedVersion?: number | undefined;
  readonly sourceVersion?: number | undefined;
  readonly actorType: "seller" | "channel" | "system";
  readonly actorId: string;
  readonly nowMs: number;
}

export type SyncOutcome =
  | { readonly status: "applied"; readonly level: LevelView; readonly oversoldUnits: number; readonly replayed: boolean }
  | { readonly status: "stale"; readonly currentSourceVersion: number }
  | { readonly status: "version_conflict"; readonly currentVersion: number }
  | { readonly status: "negative"; readonly wouldBe: number };

export interface TransferCommand {
  readonly skuId: string;
  readonly locationId: string;
  readonly fromPoolId: string;
  readonly toPoolId: string;
  readonly storeId: string;
  readonly qty: number;
  readonly idempotencyKey: string;
  readonly nowMs: number;
}

export type TransferOutcome =
  | { readonly status: "transferred"; readonly replayed: boolean }
  | { readonly status: "insufficient"; readonly free: number }
  | { readonly status: "invalid" };
