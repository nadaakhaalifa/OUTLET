import { InvalidPayoutInputError } from "./errors";
import { MS_PER_DAY } from "./cairo";

/** Buffer after a seller order closes (return window elapsed) before it is paid: spec T4 "return window plus 3 days". */
export const PAYOUT_HOLD_AFTER_CLOSE_MS = 3 * MS_PER_DAY;
/** 100 EGP. Admin-editable; VERIFY BEFORE LAUNCH (VR-F1-09). */
export const DEFAULT_MINIMUM_PAYOUT_MINOR = 10_000n;

/** One seller order's seller-side net (merchandise - commission - VAT on commission). */
export interface PayableItem {
  readonly sellerOrderId: string;
  readonly storeId: string;
  /** What the ledger credited to `seller_payable` for this order, in piastres. */
  readonly net: bigint;
  readonly status: string;
  readonly closedAtMs: number | null;
  readonly openDispute: boolean;
}

export const CLAWBACK_KINDS = ["refund_after_payout", "promo_netting", "chargeback", "other"] as const;
export type ClawbackKind = (typeof CLAWBACK_KINDS)[number];

/** An amount the seller owes back. The ledger already reduced `seller_payable` for it. */
export interface Clawback {
  readonly id: string;
  readonly storeId: string;
  /** Positive piastres owed by the seller. */
  readonly amount: bigint;
  readonly kind: ClawbackKind;
  readonly createdAtMs: number;
}

export type IneligibleReason =
  | "wrong_store"
  | "not_closed"
  | "hold_window"
  | "open_dispute"
  | "non_positive";

export interface PayoutPlanInput {
  readonly storeId: string;
  readonly items: readonly PayableItem[];
  readonly clawbacks: readonly Clawback[];
  readonly cutoffMs: number;
  readonly minimumPayoutMinor?: bigint;
}

export interface AppliedClawback {
  readonly clawbackId: string;
  readonly applied: bigint;
  /** Owed amount that stays outstanding after this payout. */
  readonly remaining: bigint;
}

export type PlanSkipReason = "nothing_eligible" | "below_minimum";

export interface PayoutPlan {
  readonly storeId: string;
  readonly cutoffMs: number;
  readonly eligible: readonly PayableItem[];
  readonly ineligible: readonly { readonly item: PayableItem; readonly reason: IneligibleReason }[];
  readonly eligibleTotal: bigint;
  readonly applied: readonly AppliedClawback[];
  readonly nettedTotal: bigint;
  /** Clawback value still outstanding after this plan (carried to the next cycle). */
  readonly carryForward: bigint;
  /** Amount to send. 0n when the plan is not payable. */
  readonly payout: bigint;
  readonly payable: boolean;
  readonly skip: PlanSkipReason | null;
}

export function ineligibleReason(item: PayableItem, storeId: string, cutoffMs: number): IneligibleReason | null {
  if (item.storeId !== storeId) return "wrong_store";
  if (item.status !== "CLOSED" || item.closedAtMs === null) return "not_closed";
  if (item.closedAtMs + PAYOUT_HOLD_AFTER_CLOSE_MS > cutoffMs) return "hold_window";
  if (item.openDispute) return "open_dispute";
  if (item.net <= 0n) return "non_positive";
  return null;
}

const byItem = (a: PayableItem, b: PayableItem): number =>
  (a.closedAtMs ?? 0) - (b.closedAtMs ?? 0) || (a.sellerOrderId < b.sellerOrderId ? -1 : a.sellerOrderId > b.sellerOrderId ? 1 : 0);
const byClawback = (a: Clawback, b: Clawback): number =>
  a.createdAtMs - b.createdAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Pure payout plan for one store and one cutoff. Eligible items are summed, clawbacks are consumed
 * oldest first (partial application, never below zero), and a plan below the minimum is not
 * payable: nothing is consumed and everything carries to the next cycle.
 * Conservation: eligibleTotal = payout + nettedTotal whenever the plan is payable.
 */
export function planPayout(input: PayoutPlanInput): PayoutPlan {
  const minimum = input.minimumPayoutMinor ?? DEFAULT_MINIMUM_PAYOUT_MINOR;
  if (minimum < 0n) throw new InvalidPayoutInputError("minimum payout must not be negative");
  const seen = new Set<string>();
  for (const i of input.items) {
    if (seen.has(i.sellerOrderId)) throw new InvalidPayoutInputError(`duplicate seller order ${i.sellerOrderId}`);
    seen.add(i.sellerOrderId);
  }
  const claw = new Set<string>();
  for (const c of input.clawbacks) {
    if (c.amount <= 0n) throw new InvalidPayoutInputError("a clawback amount must be positive");
    if (claw.has(c.id)) throw new InvalidPayoutInputError(`duplicate clawback ${c.id}`);
    claw.add(c.id);
  }

  const eligible: PayableItem[] = [];
  const ineligible: { item: PayableItem; reason: IneligibleReason }[] = [];
  for (const item of [...input.items].sort(byItem)) {
    const reason = ineligibleReason(item, input.storeId, input.cutoffMs);
    if (reason === null) eligible.push(item);
    else ineligible.push({ item, reason });
  }
  const eligibleTotal = eligible.reduce((a, i) => a + i.net, 0n);
  const mine = input.clawbacks.filter((c) => c.storeId === input.storeId).sort(byClawback);
  const owed = mine.reduce((a, c) => a + c.amount, 0n);

  const notPayable = (skip: PlanSkipReason): PayoutPlan => ({
    storeId: input.storeId,
    cutoffMs: input.cutoffMs,
    eligible: [],
    ineligible,
    eligibleTotal,
    applied: [],
    nettedTotal: 0n,
    carryForward: owed,
    payout: 0n,
    payable: false,
    skip,
  });
  if (eligible.length === 0) return notPayable("nothing_eligible");

  let remaining = eligibleTotal;
  const applied: AppliedClawback[] = [];
  let netted = 0n;
  for (const c of mine) {
    const take = c.amount < remaining ? c.amount : remaining;
    remaining -= take;
    netted += take;
    applied.push({ clawbackId: c.id, applied: take, remaining: c.amount - take });
  }
  if (remaining <= 0n || remaining < minimum) return notPayable("below_minimum");
  return {
    storeId: input.storeId,
    cutoffMs: input.cutoffMs,
    eligible,
    ineligible,
    eligibleTotal,
    applied: applied.filter((a) => a.applied > 0n),
    nettedTotal: netted,
    carryForward: owed - netted,
    payout: remaining,
    payable: true,
    skip: null,
  };
}
