import { splitFee } from "./fee";
import {
  DEFAULT_HUB_CONFIG,
  InvalidHubInputError,
  type HubConfig,
  type HubLeg,
} from "./types";

export interface PlanInput {
  readonly legs: readonly HubLeg[];
  /** Shopper preference "ship together" (default true). */
  readonly shipTogether: boolean;
  /** When the order group was paid: both the handoff SLA and the wait window start here. */
  readonly paidAtMs: number;
  readonly nowMs: number;
  /** The single delivery fee of the OrderGroup, piastres. */
  readonly deliveryFee: bigint;
  readonly config?: HubConfig;
}

export interface PlannedParcel {
  readonly sellerOrderIds: readonly string[];
  readonly lineIds: readonly string[];
  /** What the shopper is charged for this parcel. Only the first parcel of the group carries the fee. */
  readonly shopperFee: bigint;
}

export type PlanDecision =
  | { readonly kind: "nothing" }
  | {
      readonly kind: "wait";
      readonly reason: "awaiting_all_legs" | "nothing_received";
      readonly waitingForSellerOrderIds: readonly string[];
      readonly splitAtMs: number;
    }
  | {
      readonly kind: "dispatch";
      readonly parcels: readonly PlannedParcel[];
      /** Seller orders still to arrive; they ship later with the fee waived. */
      readonly lateSellerOrderIds: readonly string[];
      readonly split: boolean;
      /** Per seller order share of the one delivery fee (sums to the fee), for per-line refunds. */
      readonly feeAllocation: Readonly<Record<string, bigint>>;
    };

/**
 * Pure consolidation planner. Legs already CONSOLIDATED or DISPATCHED are assigned and ignored,
 * except that an earlier DISPATCHED parcel means the fee was already charged, so a later parcel
 * of the same group is free. CANCELLED and EXCEPTION legs never ship.
 *
 * Options compared (spec rule "ship together up to 72 h, then split"):
 *  (a) eager split: dispatch whatever is ready as it arrives. Fewer dwell hours, more parcels and
 *      more last-mile trips (cost and gCO2e up).
 *  (b) hold until complete or the window ends, then split (chosen): one parcel in the common
 *      case, bounded delay, and the shopper never pays twice.
 */
export function planConsolidation(input: PlanInput): PlanDecision {
  const cfg = input.config ?? DEFAULT_HUB_CONFIG;
  if (input.deliveryFee < 0n) throw new InvalidHubInputError("delivery fee must not be negative");
  const seen = new Set<string>();
  for (const leg of input.legs) {
    if (seen.has(leg.sellerOrderId)) throw new InvalidHubInputError("duplicate seller order in plan");
    seen.add(leg.sellerOrderId);
  }
  const unassigned = input.legs.filter((l) => l.state === "AT_HUB_EXPECTED" || l.state === "RECEIVED");
  if (unassigned.length === 0) return { kind: "nothing" };
  const ready = unassigned.filter((l) => l.state === "RECEIVED");
  const pending = unassigned.filter((l) => l.state === "AT_HUB_EXPECTED");
  const splitAtMs = input.paidAtMs + cfg.shipTogetherWaitMs;

  if (ready.length === 0) {
    return {
      kind: "wait",
      reason: "nothing_received",
      waitingForSellerOrderIds: pending.map((l) => l.sellerOrderId),
      splitAtMs,
    };
  }
  const windowElapsed = input.nowMs >= splitAtMs;
  if (pending.length > 0 && input.shipTogether && !windowElapsed) {
    return {
      kind: "wait",
      reason: "awaiting_all_legs",
      waitingForSellerOrderIds: pending.map((l) => l.sellerOrderId),
      splitAtMs,
    };
  }

  const alreadyShipped = input.legs.some((l) => l.state === "DISPATCHED");
  const live = input.legs.filter((l) => l.state !== "CANCELLED" && l.state !== "EXCEPTION");
  const shares = splitFee(input.deliveryFee, live.map((l) => l.subtotal));
  const feeAllocation: Record<string, bigint> = {};
  live.forEach((l, i) => {
    feeAllocation[l.sellerOrderId] = shares[i] ?? 0n;
  });

  const parcel: PlannedParcel = {
    sellerOrderIds: ready.map((l) => l.sellerOrderId),
    lineIds: ready.flatMap((l) => l.lineIds),
    shopperFee: alreadyShipped ? 0n : input.deliveryFee,
  };
  return {
    kind: "dispatch",
    parcels: [parcel],
    lateSellerOrderIds: pending.map((l) => l.sellerOrderId),
    split: pending.length > 0,
    feeAllocation,
  };
}
