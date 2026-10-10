import { defineMachine, guard } from "../state-machine/machine";
import { InvalidPrivacyInputError } from "./errors";

/**
 * Account deletion (spec section 2): blocked while orders, returns or disputes are open, then a
 * 14-day cooling period, then erasure or pseudonymisation per the data inventory.
 *
 *   cooling -cancel-> cancelled              (only while cooling is running)
 *   cooling -hold-> on_hold                  (cooling ended, a blocker appeared)
 *   cooling|on_hold -begin_erasure-> erasing (cooling ended, no blockers)
 *   on_hold -cancel-> cancelled
 *   erasing -complete-> completed
 */
export const DELETION_STATES = ["cooling", "on_hold", "cancelled", "erasing", "completed"] as const;
export type DeletionState = (typeof DELETION_STATES)[number];

export const DELETION_EVENTS = ["hold", "cancel", "begin_erasure", "complete", "park"] as const;
export type DeletionEvent = (typeof DELETION_EVENTS)[number];

export const DEFAULT_COOLING_DAYS = 14;

export interface DeletionCtx {
  readonly nowMs: number;
  readonly coolingEndsAtMs: number;
}

const coolingEnded = guard<DeletionCtx>("cooling_ended", (c) => c.nowMs >= c.coolingEndsAtMs);
const coolingRunning = guard<DeletionCtx>("cooling_running", (c) => c.nowMs < c.coolingEndsAtMs);

export const deletionMachine = defineMachine<DeletionState, DeletionEvent, DeletionCtx>({
  name: "privacy.deletion_request",
  states: DELETION_STATES,
  events: DELETION_EVENTS,
  initial: "cooling",
  terminal: ["cancelled", "completed"],
  transitions: {
    cooling: {
      hold: { to: "on_hold", guard: coolingEnded },
      cancel: { to: "cancelled", guard: coolingRunning },
      begin_erasure: { to: "erasing", guard: coolingEnded },
    },
    on_hold: {
      cancel: { to: "cancelled" },
      begin_erasure: { to: "erasing", guard: coolingEnded },
    },
    cancelled: {},
    erasing: { complete: { to: "completed" }, park: { to: "on_hold" } },
    completed: {},
  },
});

export const DELETION_BLOCKER_KINDS = ["open_orders", "open_returns", "open_disputes"] as const;
export type DeletionBlockerKind = (typeof DELETION_BLOCKER_KINDS)[number];

export interface DeletionBlocker {
  readonly kind: DeletionBlockerKind;
  readonly count: number;
}

/** User-facing reasons, so the UI can show exactly why deletion is blocked (spec section 2 Flow). */
export const DELETION_BLOCKER_MESSAGES: Readonly<Record<DeletionBlockerKind, { readonly ar: string; readonly en: string }>> = {
  open_orders: { ar: "لديك طلبات لم تكتمل بعد.", en: "You have orders that are not complete yet." },
  open_returns: { ar: "لديك طلبات إرجاع قيد المعالجة.", en: "You have returns that are still in progress." },
  open_disputes: { ar: "لديك نزاعات مفتوحة.", en: "You have open disputes." },
};

export interface DeletionSnapshot {
  readonly openOrders: number;
  readonly openReturns: number;
  readonly openDisputes: number;
  /** Store credit in piastres, never negative. */
  readonly storeCreditMinor: bigint;
}

function assertSnapshot(s: DeletionSnapshot): void {
  for (const [k, v] of [
    ["openOrders", s.openOrders],
    ["openReturns", s.openReturns],
    ["openDisputes", s.openDisputes],
  ] as const) {
    if (!Number.isInteger(v) || v < 0) throw new InvalidPrivacyInputError(`${k} must be a non-negative integer`);
  }
  if (s.storeCreditMinor < 0n) throw new InvalidPrivacyInputError("storeCreditMinor must not be negative");
}

export function deletionBlockers(s: DeletionSnapshot): readonly DeletionBlocker[] {
  assertSnapshot(s);
  const out: DeletionBlocker[] = [];
  if (s.openOrders > 0) out.push({ kind: "open_orders", count: s.openOrders });
  if (s.openReturns > 0) out.push({ kind: "open_returns", count: s.openReturns });
  if (s.openDisputes > 0) out.push({ kind: "open_disputes", count: s.openDisputes });
  return out;
}

export interface DeletionRequest {
  readonly kind: "delete";
  readonly id: string;
  readonly userId: string;
  readonly status: DeletionState;
  readonly requestedAtMs: number;
  readonly coolingEndsAtMs: number;
  readonly forfeitedCreditMinor: bigint;
  readonly blockers: readonly DeletionBlocker[];
  /** Failed erasure runs so far (worker retries with backoff). */
  readonly attempts: number;
  /** Set when the worker gave up: the request is parked for the DPO and never retried automatically. */
  readonly failureCode: string | null;
  readonly completedAtMs: number | null;
  readonly cancelledAtMs: number | null;
  readonly version: number;
  readonly updatedAtMs: number;
}

export type StartDeletionResult =
  | { readonly kind: "ok"; readonly request: DeletionRequest }
  | { readonly kind: "blocked"; readonly blockers: readonly DeletionBlocker[] }
  | { readonly kind: "forfeiture_ack_required"; readonly balanceMinor: bigint };

export function startDeletion(
  input: { readonly id: string; readonly userId: string; readonly acknowledgedForfeiture: boolean },
  snapshot: DeletionSnapshot,
  nowMs: number,
  coolingDays: number = DEFAULT_COOLING_DAYS,
): StartDeletionResult {
  if (!Number.isInteger(coolingDays) || coolingDays < 0) throw new InvalidPrivacyInputError("coolingDays must be >= 0");
  if (input.id.length === 0 || input.userId.length === 0) throw new InvalidPrivacyInputError("id and userId are required");
  const blockers = deletionBlockers(snapshot);
  if (blockers.length > 0) return { kind: "blocked", blockers };
  if (snapshot.storeCreditMinor > 0n && !input.acknowledgedForfeiture) {
    return { kind: "forfeiture_ack_required", balanceMinor: snapshot.storeCreditMinor };
  }
  return {
    kind: "ok",
    request: {
      kind: "delete",
      id: input.id,
      userId: input.userId,
      status: deletionMachine.initial,
      requestedAtMs: nowMs,
      coolingEndsAtMs: nowMs + coolingDays * 86_400_000,
      forfeitedCreditMinor: snapshot.storeCreditMinor,
      blockers: [],
      attempts: 0,
      failureCode: null,
      completedAtMs: null,
      cancelledAtMs: null,
      version: 0,
      updatedAtMs: nowMs,
    },
  };
}

const ctxOf = (r: DeletionRequest, nowMs: number): DeletionCtx => ({ nowMs, coolingEndsAtMs: r.coolingEndsAtMs });
const bump = (r: DeletionRequest, nowMs: number, patch: Partial<DeletionRequest>): DeletionRequest => ({
  ...r,
  ...patch,
  version: r.version + 1,
  updatedAtMs: nowMs,
});

export function cancelDeletion(r: DeletionRequest, nowMs: number): DeletionRequest {
  const status = deletionMachine.transition(r.status, "cancel", ctxOf(r, nowMs));
  return bump(r, nowMs, { status, cancelledAtMs: nowMs });
}

/** Cooling ended and blockers exist (an order was placed during cooling): park the request. */
export function holdDeletion(r: DeletionRequest, blockers: readonly DeletionBlocker[], nowMs: number): DeletionRequest {
  if (blockers.length === 0) throw new InvalidPrivacyInputError("hold needs at least one blocker");
  const status = deletionMachine.transition(r.status, "hold", ctxOf(r, nowMs));
  return bump(r, nowMs, { status, blockers });
}

export function beginErasure(r: DeletionRequest, nowMs: number): DeletionRequest {
  const status = deletionMachine.transition(r.status, "begin_erasure", ctxOf(r, nowMs));
  return bump(r, nowMs, { status, blockers: [] });
}

export function completeErasure(r: DeletionRequest, nowMs: number): DeletionRequest {
  const status = deletionMachine.transition(r.status, "complete", ctxOf(r, nowMs));
  return bump(r, nowMs, { status, completedAtMs: nowMs });
}

export const MAX_ERASURE_ATTEMPTS = 5;
export const ERASURE_PARKED_CODE = "erasure_failed_max_attempts";
const BACKOFF_BASE_MS = 5 * 60_000;
const BACKOFF_CAP_MS = 6 * 3_600_000;

/** Earliest next try after `attempts` failures: 5 min, 10 min, 20 min ... capped at 6 h. */
export function erasureBackoffMs(attempts: number): number {
  if (attempts <= 0) return 0;
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempts - 1));
}

export function isErasureParked(r: DeletionRequest): boolean {
  return r.status === "on_hold" && r.failureCode === ERASURE_PARKED_CODE;
}

/**
 * One failed erasure run. Stays `erasing` (resumable, executor is idempotent) until
 * MAX_ERASURE_ATTEMPTS, then parks in `on_hold` with a failure code for the DPO.
 */
export function recordErasureFailure(r: DeletionRequest, nowMs: number): DeletionRequest {
  const attempts = r.attempts + 1;
  if (attempts >= MAX_ERASURE_ATTEMPTS && r.status === "erasing") {
    const status = deletionMachine.transition(r.status, "park", ctxOf(r, nowMs));
    return bump(r, nowMs, { status, attempts, failureCode: ERASURE_PARKED_CODE });
  }
  return bump(r, nowMs, { attempts, failureCode: "erasure_failed" });
}

export function isDeletionActive(r: DeletionRequest): boolean {
  return !deletionMachine.isTerminal(r.status);
}
