/**
 * Budget suite (spec 12, docs/specs/phase2/03-budget-affordability.md). Pure types: no I/O, no
 * clock. Instants are epoch milliseconds injected by callers; money is integer piastres (bigint).
 *
 * Isolation (spec 12, 17): nothing here may be imported by promotions, ads, seller analytics or
 * recommendation/ranking code. dependency-cruiser enforces it (.dependency-cruiser.cjs).
 */

export const CAP_MODES = ["off", "soft", "hard"] as const;
export type CapMode = (typeof CAP_MODES)[number];

export const AFFORDABILITY_CONTEXTS = ["feed", "search", "stylist", "wishlist"] as const;
export type AffordabilityContext = (typeof AFFORDABILITY_CONTEXTS)[number];

export const PLAN_PRIORITIES = ["need", "dated", "want", "treat"] as const;
export type PlanPriority = (typeof PLAN_PRIORITIES)[number];

export const COMMITMENT_SOURCES = ["provider", "user"] as const;
export type CommitmentSource = (typeof COMMITMENT_SOURCES)[number];

export const SPEND_KINDS = ["placed", "refund", "cod_refusal"] as const;
export type SpendKind = (typeof SPEND_KINDS)[number];

export const BUDGET_LIMITS = {
  /** 1,000,000 EGP in piastres. A sanity bound, not a product limit. */
  maxAmount: 100_000_000n,
  paydayMin: 1,
  paydayMax: 31,
  maxCategories: 30,
  maxCommitments: 20,
  planHorizonCycles: 6,
  planMaxItems: 200,
} as const;

export const SOFT_HOLD_SECONDS = 10;
export const SOFT_HOLD_MAX_AGE_MS = 10 * 60 * 1000;
export const HARD_UNLOCK_DELAY_MS = 24 * 60 * 60 * 1000;

export interface BudgetSettings {
  readonly amount: bigint;
  readonly perCategory: Readonly<Record<string, bigint>>;
  readonly payday: number;
  readonly capMode: CapMode;
}

export interface Cycle {
  readonly startMs: number;
  /** Exclusive: the instant the next cycle (the next payday) begins. */
  readonly endMs: number;
  /** Cairo local dates, YYYY-MM-DD. `endDate` is the next payday. */
  readonly startDate: string;
  readonly endDate: string;
}

export interface SpendLine {
  readonly storeId: string;
  readonly categoryId: string;
  readonly amount: bigint;
}

/**
 * One money movement the budget cares about. `orderPlacedAtMs` always names the order's original
 * placement so a refund can be credited to the original cycle in reports.
 */
export interface SpendEvent {
  /** Idempotency key, unique per user (e.g. `placed:<orderGroupId>`). */
  readonly key: string;
  readonly kind: SpendKind;
  /** Positive piastres. */
  readonly amount: bigint;
  readonly orderPlacedAtMs: number;
  readonly occurredAtMs: number;
  readonly lines: readonly SpendLine[];
  /** Verified-reference savings only (spec 12). Zero when unverified. */
  readonly verifiedSavings: bigint;
  readonly plusSavings: bigint;
}

export interface Commitment {
  readonly provider: string;
  readonly monthly: bigint;
  readonly startsAtMs: number;
  readonly endsAtMs: number;
  readonly source: CommitmentSource;
}

export interface RemainingInput {
  readonly budget: bigint;
  readonly spent: bigint;
  readonly bagTotal: bigint;
  readonly includeBag: boolean;
  readonly installmentsDue: bigint;
}

export interface Remaining {
  readonly budget: bigint;
  readonly spent: bigint;
  readonly bag: bigint;
  readonly installments: bigint;
  /** Signed. Negative means over budget. */
  readonly remaining: bigint;
  /** Display value, clamped at zero. */
  readonly remainingDisplay: bigint;
  /** Explicit "over by X". Zero when not over. */
  readonly overBy: bigint;
}

export interface PlanItem {
  readonly id: string;
  readonly priority: PlanPriority;
  readonly price: bigint;
  /** Target date for dated items (birthday, Eid, gift). */
  readonly dueAtMs: number | null;
}

export interface PlanCycle {
  readonly index: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly capacity: bigint;
}

export interface PlannedItem {
  readonly id: string;
  readonly priority: PlanPriority;
  readonly price: bigint;
  readonly cycleIndex: number;
  /** True when the cycle starts after the item's target date. */
  readonly missesDate: boolean;
  /** True when deferred beyond the current cycle: consumers watch verified price drops. */
  readonly watchPriceDrop: boolean;
}

export interface Plan {
  readonly planned: readonly PlannedItem[];
  readonly unplanned: readonly { readonly id: string; readonly reason: "exceeds_every_cycle" | "no_capacity" }[];
  readonly usedByCycle: readonly bigint[];
}

export type CapDecision =
  | { readonly kind: "allow"; readonly reason: "cap_off" | "within_budget" | "soft_confirmed" | "hard_unlocked" | "service_unavailable" }
  | { readonly kind: "soft_hold"; readonly holdSeconds: number; readonly overBy: bigint }
  | {
      readonly kind: "blocked";
      readonly reason: "hard_cap";
      readonly overBy: bigint;
      /** Pending unlock (24h delay) when one was requested, else null. */
      readonly unlockAtMs: number | null;
      readonly cycleEndMs: number;
    };
