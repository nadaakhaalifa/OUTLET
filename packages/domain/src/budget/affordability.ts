import { BUDGET_LIMITS, type BudgetSettings, type CapMode, type Commitment, type Cycle, type Remaining, type RemainingInput, type SpendEvent } from "./types";
import { CAP_MODES } from "./types";

const inCycle = (ms: number, c: Cycle): boolean => ms >= c.startMs && ms < c.endMs;
const clampZero = (n: bigint): bigint => (n < 0n ? 0n : n);

/**
 * remaining = budget - spent - (bag if toggled) - installments due (spec 12). Signed; the display
 * value is clamped and the shortfall is reported explicitly as `overBy`.
 */
export function computeRemaining(i: RemainingInput): Remaining {
  const bag = i.includeBag ? i.bagTotal : 0n;
  const remaining = i.budget - i.spent - bag - i.installmentsDue;
  return {
    budget: i.budget,
    spent: i.spent,
    bag,
    installments: i.installmentsDue,
    remaining,
    remainingDisplay: clampZero(remaining),
    overBy: clampZero(-remaining),
  };
}

export interface CycleTotals {
  /** Gross placements in the cycle (COD counts at placement). */
  readonly placed: bigint;
  /** Refunds and COD refusals attributed to orders placed in the cycle, whenever they happened. */
  readonly refundedToOrigin: bigint;
  /** Report figure: placed - refundedToOrigin, never below zero. */
  readonly netSpentReport: bigint;
  /** Refunds and COD refusals received during the cycle, for any order's origin cycle. */
  readonly refundsReceived: bigint;
  /** "Available now" spend: placed - refundsReceived, never below zero. */
  readonly spentNow: bigint;
  readonly verifiedSavings: bigint;
  readonly plusSavings: bigint;
}

/**
 * Spend net of refunds (spec 12). A refund in a later cycle credits the original cycle in reports
 * (`netSpentReport`) and lifts "available now" in the current one (`spentNow`).
 */
export function cycleTotals(events: readonly SpendEvent[], cycle: Cycle): CycleTotals {
  let placed = 0n;
  let refundedToOrigin = 0n;
  let refundsReceived = 0n;
  let verifiedSavings = 0n;
  let plusSavings = 0n;
  for (const e of events) {
    if (e.kind === "placed") {
      if (inCycle(e.orderPlacedAtMs, cycle)) {
        placed += e.amount;
        verifiedSavings += e.verifiedSavings;
        plusSavings += e.plusSavings;
      }
    } else {
      if (inCycle(e.orderPlacedAtMs, cycle)) refundedToOrigin += e.amount;
      if (inCycle(e.occurredAtMs, cycle)) refundsReceived += e.amount;
    }
  }
  return {
    placed,
    refundedToOrigin,
    netSpentReport: clampZero(placed - refundedToOrigin),
    refundsReceived,
    spentNow: clampZero(placed - refundsReceived),
    verifiedSavings,
    plusSavings,
  };
}

export interface BreakdownRow {
  readonly id: string;
  readonly amount: bigint;
}

/** Net category and store breakdown for placements in the cycle (refund lines subtract). */
export function breakdown(events: readonly SpendEvent[], cycle: Cycle): { byCategory: BreakdownRow[]; topStores: BreakdownRow[] } {
  const cat = new Map<string, bigint>();
  const store = new Map<string, bigint>();
  for (const e of events) {
    if (!inCycle(e.orderPlacedAtMs, cycle)) continue;
    const sign = e.kind === "placed" ? 1n : -1n;
    for (const l of e.lines) {
      cat.set(l.categoryId, (cat.get(l.categoryId) ?? 0n) + sign * l.amount);
      store.set(l.storeId, (store.get(l.storeId) ?? 0n) + sign * l.amount);
    }
  }
  const rows = (m: Map<string, bigint>): BreakdownRow[] =>
    [...m.entries()]
      .map(([id, amount]) => ({ id, amount: clampZero(amount) }))
      .filter((r) => r.amount > 0n)
      .sort((a, b) => (a.amount === b.amount ? (a.id < b.id ? -1 : 1) : a.amount > b.amount ? -1 : 1));
  return { byCategory: rows(cat), topStores: rows(store).slice(0, 5) };
}

/**
 * Commitments the budget should count. Provider data wins: a user entry for a provider is dropped
 * when a provider row for the same provider overlaps it (spec edge case "source conflict").
 */
export function effectiveCommitments(all: readonly Commitment[]): Commitment[] {
  const providers = all.filter((c) => c.source === "provider");
  const overlaps = (a: Commitment, b: Commitment): boolean => a.startsAtMs < b.endsAtMs && b.startsAtMs < a.endsAtMs;
  return all.filter(
    (c) => c.source === "provider" || !providers.some((p) => p.provider.toLowerCase() === c.provider.toLowerCase() && overlaps(p, c)),
  );
}

/** One monthly instalment is due per commitment that is active at any point of the cycle. */
export function installmentsDue(all: readonly Commitment[], cycle: Cycle): bigint {
  let sum = 0n;
  for (const c of effectiveCommitments(all)) {
    if (c.startsAtMs < cycle.endMs && c.endsAtMs >= cycle.startMs) sum += c.monthly;
  }
  return sum;
}

/** The only value that leaves the budget module towards feed, search, stylist and wishlist. */
export interface PriceCeiling {
  /** null = no filter (no budget, no consent). */
  readonly ceiling: bigint | null;
}

export function priceCeiling(r: Remaining | null): PriceCeiling {
  return { ceiling: r === null ? null : r.remainingDisplay };
}

export type BudgetValidation =
  | { readonly ok: true; readonly value: BudgetSettings }
  | { readonly ok: false; readonly errors: readonly { readonly field: string; readonly code: string }[] };

export function validateBudget(input: {
  readonly amount: bigint;
  readonly perCategory?: Readonly<Record<string, bigint>>;
  readonly payday: number;
  readonly capMode: string;
}): BudgetValidation {
  const errors: { field: string; code: string }[] = [];
  if (input.amount <= 0n) errors.push({ field: "amount", code: "must_be_positive" });
  else if (input.amount > BUDGET_LIMITS.maxAmount) errors.push({ field: "amount", code: "too_large" });
  if (!Number.isInteger(input.payday) || input.payday < BUDGET_LIMITS.paydayMin || input.payday > BUDGET_LIMITS.paydayMax) {
    errors.push({ field: "payday", code: "out_of_range" });
  }
  if (!(CAP_MODES as readonly string[]).includes(input.capMode)) errors.push({ field: "cap_mode", code: "invalid" });
  const per = input.perCategory ?? {};
  const keys = Object.keys(per);
  if (keys.length > BUDGET_LIMITS.maxCategories) errors.push({ field: "per_category", code: "too_many" });
  for (const k of keys) {
    const v = per[k];
    if (k.length === 0 || k.length > 64 || v === undefined || v <= 0n || v > BUDGET_LIMITS.maxAmount) {
      errors.push({ field: `per_category.${k.slice(0, 64)}`, code: "invalid" });
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { amount: input.amount, perCategory: { ...per }, payday: input.payday, capMode: input.capMode as CapMode },
  };
}
