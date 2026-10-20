import type { CreatorAccountWire, CreatorDecision, CreatorPayoutState, CreatorPayoutWire, CreatorStatus } from "../api/phase3-schemas";
import type { FlagWire } from "../api/schemas";
import { parseMinor } from "../lib/format";
import { stateFor, type SwitchState } from "./killswitch";

export const CREATOR_PAYOUTS_KEY = "kill.creator_payouts";
export const CREATOR_PROGRAM_KEY = "kill.creator_program";

/** Decisions the state machine accepts per application status (apps/api creators DecideCreator). */
export const DECISIONS_BY_STATUS: Readonly<Record<CreatorStatus, readonly CreatorDecision[]>> = {
  APPLIED: ["approve", "reject", "needs_info"],
  ACTIVE: ["suspend"],
  SUSPENDED: ["reinstate"],
  REJECTED: [],
};

export interface CreatorRow {
  readonly id: string;
  readonly handle: string;
  readonly displayName: string;
  readonly status: CreatorStatus;
  readonly kycState: string;
  readonly reason: string | null;
  readonly appliedAt: string | null;
  readonly decisions: readonly CreatorDecision[];
}

export function creatorRows(items: readonly CreatorAccountWire[]): readonly CreatorRow[] {
  return items.map((c) => ({
    id: c.id, handle: c.handle, displayName: c.display_name, status: c.status, kycState: c.kyc_state,
    reason: c.status_reason ?? null, appliedAt: c.applied_at ?? null, decisions: DECISIONS_BY_STATUS[c.status],
  }));
}

/** Approving needs review evidence in `reason` (API 422 review_evidence_required); every other decision may omit it. */
export function decisionReasonError(action: CreatorDecision, reason: string): "required" | "too_long" | null {
  const r = reason.trim();
  if (r.length > 200) return "too_long";
  if (action === "approve" && r.length === 0) return "required";
  return null;
}

export type PayoutAction = "approve" | "send" | "outcome_settled" | "outcome_rejected" | "cancel";

export interface PayoutRow {
  readonly id: string;
  readonly creatorId: string;
  readonly amountMinor: bigint;
  readonly state: CreatorPayoutState;
  readonly holdReason: string | null;
  readonly failureReason: string | null;
  readonly attempt: number;
  readonly createdBy: string | null;
  readonly createdAt: string | null;
  /** Actions the state machine allows now (before the kill switch and the dual-approval rule are applied). */
  readonly actions: readonly PayoutAction[];
  /** True when the signed-in admin created this payout: the API answers 403 dual_approval_required to their approve. */
  readonly selfCreated: boolean;
}

const BASE_ACTIONS: Readonly<Record<CreatorPayoutState, readonly PayoutAction[]>> = {
  SCHEDULED: ["approve", "cancel"],
  ON_HOLD: ["approve", "cancel"],
  APPROVED: ["send", "cancel"],
  SENT: ["outcome_settled", "outcome_rejected"],
  SETTLED: [],
  FAILED: [],
  CANCELLED: [],
};

export function payoutRows(items: readonly CreatorPayoutWire[], selfId: string | null): readonly PayoutRow[] {
  return items.map((p) => ({
    id: p.id, creatorId: p.creator_id, amountMinor: parseMinor(p.amount.amount) ?? 0n, state: p.state,
    holdReason: p.hold_reason ?? null, failureReason: p.failure_reason ?? null, attempt: p.attempt,
    createdBy: p.created_by ?? null, createdAt: p.created_at ?? null, actions: BASE_ACTIONS[p.state],
    selfCreated: selfId !== null && p.created_by === selfId,
  }));
}

export interface PayoutGate {
  readonly state: SwitchState;
  readonly reported: boolean;
  /** Every money-moving action is disabled while the switch is Blocked or unreported (fail closed). */
  readonly moneyActionsEnabled: boolean;
}

/** `kill.creator_payouts` is engaged OFF by default: Blocked until an owner allows it after VR-P3-03 is Verified. */
export function payoutGate(flags: readonly FlagWire[] | null): PayoutGate {
  if (flags === null) return { state: "blocked", reported: false, moneyActionsEnabled: false };
  const s = stateFor(flags, CREATOR_PAYOUTS_KEY);
  return { state: s.state, reported: s.reported, moneyActionsEnabled: s.state === "allowed" };
}

export type ActionAvailability = { readonly enabled: true } | { readonly enabled: false; readonly why: "kill_switch" | "self_created" | "writes_disabled" };

/**
 * Cancel never moves money, so it stays available while payouts are Blocked (an operator can clear a stuck request).
 * Approve is refused for the admin who created the payout (dual approval).
 */
export function actionAvailability(row: PayoutRow, action: PayoutAction, gate: PayoutGate, writesEnabled: boolean): ActionAvailability {
  if (!writesEnabled) return { enabled: false, why: "writes_disabled" };
  if (action !== "cancel" && !gate.moneyActionsEnabled) return { enabled: false, why: "kill_switch" };
  if (action === "approve" && row.selfCreated) return { enabled: false, why: "self_created" };
  return { enabled: true };
}

export function payoutTone(s: CreatorPayoutState): "ok" | "warn" | "bad" | "neutral" {
  if (s === "SETTLED") return "ok";
  if (s === "FAILED") return "bad";
  if (s === "ON_HOLD" || s === "SENT") return "warn";
  return "neutral";
}
