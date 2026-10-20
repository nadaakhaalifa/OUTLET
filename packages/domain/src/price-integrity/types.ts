/** Price Integrity (master prompt section 9, v1: internal price ledger only). Pure: no IO, no clock, no randomness. */

export const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 86_400_000;

/** Look-back for every reference price (EU 30-day prior-price model). */
export const WINDOW_DAYS = 30;
export const WINDOW_MS = WINDOW_DAYS * MS_PER_DAY;
/** A claim needs at least this integer percentage (spec 9.3). */
export const MIN_CLAIM_PCT = 5;
/** External evidence older than this fails closed (spec 9.7). */
export const EXTERNAL_STALE_MS = 72 * MS_PER_HOUR;
/** Product-match confidence threshold in basis points (0.92, spec 9.2). */
export const MATCH_CONF_TAU_BP = 9_200;

export const PRICE_EVENT_SOURCES = ["seller", "import", "channel_sync", "admin", "system", "odoo"] as const;
export type PriceEventSource = (typeof PRICE_EVENT_SOURCES)[number];

/** One immutable change point of a SKU's price. `valid_to` is implied by the next event. */
export interface PriceEvent {
  readonly id: string;
  readonly skuId: string;
  /** Integer piastres, > 0. */
  readonly priceAmount: bigint;
  readonly validFromMs: number;
  readonly source: PriceEventSource;
  readonly actorId: string | null;
}

/** Evidence from another channel, supplied through a port (crawler lands in Phase 2). */
export interface ExternalEvidence {
  readonly id: string;
  /** Lowest price the matched product held on the other channel over its last 30 days. */
  readonly lowPriceAmount: bigint;
  /** Price on that channel right now, when known (feeds cross-channel parity). */
  readonly currentPriceAmount: bigint | null;
  /** Match confidence in basis points, 0..10000. */
  readonly matchConfBp: number;
  /** Days of history the channel snapshot covers. */
  readonly historyDays: number;
  readonly observedAtMs: number;
}

export type PriceStatus = "verified_discount" | "lowest_30d" | "launch_price" | "none";

export type NoClaimReason =
  | "no_history"
  | "launch_window"
  | "not_a_reduction"
  | "insufficient_history"
  | "discount_expired"
  | "reference_not_above_price"
  | "below_threshold"
  | "stale_external_evidence";

export interface EvidenceRef {
  readonly kind: "price_event" | "external";
  readonly id: string;
}

export interface VrpResult {
  readonly status: PriceStatus;
  /** Current price in force; null only when the SKU has no events. */
  readonly priceAmount: bigint | null;
  readonly vrpAmount: bigint | null;
  readonly discountPct: number | null;
  readonly claimAllowed: boolean;
  readonly reason: NoClaimReason | null;
  /** True when an increase inside the reference window lowered the reference (anti-inflation). */
  readonly inflationReset: boolean;
  /** Start of the current run of consecutive reductions, when there is one. */
  readonly chainStartMs: number | null;
  readonly evidence: readonly EvidenceRef[];
  readonly externalUsed: boolean;
  /** Fresh, matched external price strictly below ours (spec 9.3 cross-channel parity). */
  readonly crossChannelCheaper: boolean;
}

export interface VrpInput {
  readonly events: readonly PriceEvent[];
  readonly nowMs: number;
  readonly external?: ExternalEvidence | null;
}

/** Per-order-line evidence trail (spec 9.3 Snapshots). */
export interface VrpSnapshot {
  readonly priceAmount: bigint | null;
  readonly vrpAmount: bigint | null;
  readonly discountPct: number | null;
  readonly claimType: PriceStatus;
  readonly evidenceIds: readonly string[];
  readonly computedAtMs: number;
}
