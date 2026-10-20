import { defineMachine, guard } from "../state-machine/machine";
import { InvalidPrivacyInputError } from "./errors";

/**
 * Breach register entry and its legal clocks (spec B1 Breach response).
 *   detect -> triage <= 4 h -> DPO decision -> PDPC notice <= 72 h from detection
 *   -> subject notice <= 3 days. VERIFY BEFORE LAUNCH: the spec says "then to affected individuals
 *   within 3 days"; this module counts the 3 days from the PDPC notice or from the PDPC deadline,
 *   whichever is EARLIER (the subject deadline never slides later when the PDPC notice is late). Counsel to confirm.
 * All clocks are pure functions of an injected `nowMs`.
 */
export const TRIAGE_HOURS = 4;
export const PDPC_NOTICE_HOURS = 72;
export const SUBJECT_NOTICE_DAYS = 3;

const H = 3_600_000;
const D = 86_400_000;

export const BREACH_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type BreachSeverity = (typeof BREACH_SEVERITIES)[number];

export const BREACH_STATES = ["detected", "triaged", "pdpc_notified", "subjects_notified", "closed"] as const;
export type BreachState = (typeof BREACH_STATES)[number];

export const BREACH_EVENTS = ["triage", "notify_pdpc", "notify_subjects", "close"] as const;
export type BreachEvent = (typeof BREACH_EVENTS)[number];

export type DpoDecision = "notify" | "no_notification_required";

export interface BreachCtx {
  readonly decision: DpoDecision | null;
}

export const breachMachine = defineMachine<BreachState, BreachEvent, BreachCtx>({
  name: "privacy.breach",
  states: BREACH_STATES,
  events: BREACH_EVENTS,
  initial: "detected",
  terminal: ["closed"],
  transitions: {
    detected: { triage: { to: "triaged" } },
    triaged: {
      notify_pdpc: { to: "pdpc_notified", guard: guard<BreachCtx>("dpo_decided_notify", (c) => c.decision === "notify") },
      close: {
        to: "closed",
        guard: guard<BreachCtx>("dpo_decided_no_notice", (c) => c.decision === "no_notification_required"),
      },
    },
    pdpc_notified: { notify_subjects: { to: "subjects_notified" } },
    subjects_notified: { close: { to: "closed" } },
    closed: {},
  },
});

export interface BreachEntry {
  readonly id: string;
  readonly detectedAtMs: number;
  readonly severity: BreachSeverity;
  /** Must not contain personal data. */
  readonly summary: string;
  readonly affectedCount: number;
  readonly status: BreachState;
  readonly triagedAtMs: number | null;
  readonly dpoDecision: DpoDecision | null;
  readonly pdpcNotifiedAtMs: number | null;
  readonly subjectsNotifiedAtMs: number | null;
  readonly closedAtMs: number | null;
  readonly version: number;
  readonly updatedAtMs: number;
}

export function recordBreach(
  input: {
    readonly id: string;
    readonly detectedAtMs: number;
    readonly severity: BreachSeverity;
    readonly summary: string;
    readonly affectedCount: number;
  },
  nowMs: number,
): BreachEntry {
  if (input.id.length === 0) throw new InvalidPrivacyInputError("id is required");
  if (input.summary.trim().length === 0) throw new InvalidPrivacyInputError("summary is required");
  if (!Number.isInteger(input.affectedCount) || input.affectedCount < 0) {
    throw new InvalidPrivacyInputError("affectedCount must be a non-negative integer");
  }
  if (input.detectedAtMs > nowMs) throw new InvalidPrivacyInputError("detectedAt is in the future");
  return {
    id: input.id,
    detectedAtMs: input.detectedAtMs,
    severity: input.severity,
    summary: input.summary,
    affectedCount: input.affectedCount,
    status: breachMachine.initial,
    triagedAtMs: null,
    dpoDecision: null,
    pdpcNotifiedAtMs: null,
    subjectsNotifiedAtMs: null,
    closedAtMs: null,
    version: 0,
    updatedAtMs: nowMs,
  };
}

const bump = (b: BreachEntry, nowMs: number, patch: Partial<BreachEntry>): BreachEntry => ({
  ...b,
  ...patch,
  version: b.version + 1,
  updatedAtMs: nowMs,
});

export function triageBreach(b: BreachEntry, decision: DpoDecision, nowMs: number): BreachEntry {
  const status = breachMachine.transition(b.status, "triage", { decision });
  return bump(b, nowMs, { status, dpoDecision: decision, triagedAtMs: nowMs });
}

export function notifyPdpc(b: BreachEntry, nowMs: number): BreachEntry {
  const status = breachMachine.transition(b.status, "notify_pdpc", { decision: b.dpoDecision });
  return bump(b, nowMs, { status, pdpcNotifiedAtMs: nowMs });
}

export function notifySubjects(b: BreachEntry, nowMs: number): BreachEntry {
  const status = breachMachine.transition(b.status, "notify_subjects", { decision: b.dpoDecision });
  return bump(b, nowMs, { status, subjectsNotifiedAtMs: nowMs });
}

export function closeBreach(b: BreachEntry, nowMs: number): BreachEntry {
  const status = breachMachine.transition(b.status, "close", { decision: b.dpoDecision });
  return bump(b, nowMs, { status, closedAtMs: nowMs });
}

export type ClockStatus = "not_required" | "pending" | "met" | "met_late" | "overdue";

export interface ClockView {
  readonly dueAtMs: number | null;
  readonly status: ClockStatus;
  /** Negative once overdue. Null when no deadline applies or it has been met. */
  readonly msRemaining: number | null;
}

export interface BreachClocks {
  readonly triage: ClockView;
  readonly pdpc: ClockView;
  readonly subjects: ClockView;
}

function clock(dueAtMs: number | null, doneAtMs: number | null, nowMs: number): ClockView {
  if (dueAtMs === null) return { dueAtMs: null, status: "not_required", msRemaining: null };
  if (doneAtMs !== null) {
    return { dueAtMs, status: doneAtMs <= dueAtMs ? "met" : "met_late", msRemaining: null };
  }
  const remaining = dueAtMs - nowMs;
  return { dueAtMs, status: remaining < 0 ? "overdue" : "pending", msRemaining: remaining };
}

export function breachClocks(b: BreachEntry, nowMs: number): BreachClocks {
  const noNotice = b.dpoDecision === "no_notification_required";
  const pdpcDue = b.detectedAtMs + PDPC_NOTICE_HOURS * H;
  // Conservative: a late PDPC notice must not push the subject deadline later than the
  // detected + 72 h + 3 d it would have had on time. VERIFY BEFORE LAUNCH (counsel).
  const subjectsBase = Math.min(pdpcDue, b.pdpcNotifiedAtMs ?? pdpcDue);
  return {
    triage: clock(b.detectedAtMs + TRIAGE_HOURS * H, b.triagedAtMs, nowMs),
    pdpc: noNotice ? clock(null, null, nowMs) : clock(pdpcDue, b.pdpcNotifiedAtMs, nowMs),
    subjects: noNotice ? clock(null, null, nowMs) : clock(subjectsBase + SUBJECT_NOTICE_DAYS * D, b.subjectsNotifiedAtMs, nowMs),
  };
}

/** True when any legal clock is overdue and the breach is not closed. */
export function breachHasOverdueClock(b: BreachEntry, nowMs: number): boolean {
  if (b.status === "closed") return false;
  const c = breachClocks(b, nowMs);
  return c.triage.status === "overdue" || c.pdpc.status === "overdue" || c.subjects.status === "overdue";
}
