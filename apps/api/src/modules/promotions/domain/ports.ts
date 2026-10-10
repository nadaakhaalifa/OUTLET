import type { Money, Promotion, promotions } from "./bridge";

export interface LocalizedText {
  readonly ar: string;
  readonly en?: string;
}

/** A stored promotion: the pure definition plus presentation and bookkeeping. */
export interface PromotionRecord extends Promotion {
  readonly title: LocalizedText;
  readonly createdBy: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export type OwnerFilter =
  | { readonly kind: "platform" }
  | { readonly kind: "store"; readonly storeId: string };

/** The only fields an edit can change; economic terms are immutable (spec 17, promotion versions). */
export interface PromotionPatch {
  readonly title?: LocalizedText;
  readonly status?: "active" | "paused" | "ended";
  readonly endsAtMs?: number;
  readonly totalBudget?: Money;
  readonly maxDiscount?: Money;
}

export interface RedemptionInput {
  readonly promotionId: string;
  readonly promotionVersion: number;
  readonly userId: string;
  readonly orderGroupId: string;
  readonly amount: bigint;
  readonly platformFunded: bigint;
  readonly sellerFunded: bigint;
  readonly dayKey: string;
  readonly atMs: number;
}

export type RedemptionOutcome =
  | { readonly kind: "recorded"; readonly recorded: number; readonly existing: number }
  | { readonly kind: "rejected"; readonly promotionId: string; readonly reason: "cap_reached" | "budget_exhausted" | "not_found" };

/**
 * Persistence port. Contract (run against in-memory and Kysely/PGlite by the shared suite):
 * - `insert` is unique on code: a second promotion with the same code answers "code_taken".
 * - `list` is ordered by id ascending and returns records strictly after `afterId`.
 * - `update` is compare-and-set on `version`; it bumps the version and returns the new record.
 * - `candidates` returns only active promotions inside their window that are auto-apply for the given
 *   stores (or platform-wide) or whose code is in `codes`.
 * - `recordRedemptions` is all-or-nothing, idempotent per (promotion, order group), and re-checks
 *   caps and budget under a lock so concurrent commits cannot overspend.
 */
export interface PromotionRepository {
  insert(record: PromotionRecord): Promise<"created" | "code_taken">;
  get(id: string): Promise<PromotionRecord | null>;
  list(query: { readonly owner: OwnerFilter; readonly afterId: string | null; readonly limit: number }): Promise<readonly PromotionRecord[]>;
  update(id: string, expectedVersion: number, patch: PromotionPatch, nowMs: number): Promise<PromotionRecord | "stale" | null>;
  candidates(query: {
    readonly atMs: number;
    readonly storeIds: readonly string[];
    readonly codes: readonly string[];
  }): Promise<readonly PromotionRecord[]>;
  usage(
    promotionIds: readonly string[],
    userId: string,
    dayKey: string,
  ): Promise<ReadonlyMap<string, promotions.Usage>>;
  recordRedemptions(inputs: readonly RedemptionInput[]): Promise<RedemptionOutcome>;
  /** Marks APPLIED redemptions of the order group REINSTATED; returns how many changed. */
  reinstate(orderGroupId: string, nowMs: number): Promise<number>;
}

export class PromotionsUnavailableError extends Error {
  constructor() {
    super("promotion store unavailable");
    this.name = "PromotionsUnavailableError";
  }
}

/** Verifies an internal service credential (the `Authorization` header). */
export interface ServiceAuthenticator {
  verify(authorizationHeader: string | undefined): boolean;
}

export interface PromotionEvent {
  readonly name: "promotion.activated" | "promotion.ended" | "voucher.redeemed" | "voucher.reinstated";
  readonly promotionId: string | null;
  readonly orderGroupId: string | null;
  readonly atMs: number;
}

export interface PromotionEventPublisher {
  publish(event: PromotionEvent): Promise<void>;
}
