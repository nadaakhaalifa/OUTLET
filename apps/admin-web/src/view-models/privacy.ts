import type { BreachWire, DsarItemWire } from "../api/schemas";
import { countdown, type Countdown } from "../lib/format";

export interface DsarRow {
  readonly id: string;
  readonly kind: DsarItemWire["type"];
  readonly subjectRef: string;
  readonly status: string;
  readonly dueAtMs: number;
  readonly clock: Countdown;
  readonly overdue: boolean;
  readonly blockers: readonly string[];
  readonly readyTargetMissed: boolean;
}

/** Overdue first (most overdue at the top), then soonest due. Recomputed from due_at and the SERVER clock. */
export function dsarQueueRows(items: readonly DsarItemWire[], serverNowMs: number): readonly DsarRow[] {
  return items
    .map((i): DsarRow => {
      const due = Date.parse(i.due_at);
      return {
        id: i.id,
        kind: i.type,
        subjectRef: i.subject_ref,
        status: i.status,
        dueAtMs: due,
        clock: countdown(due, serverNowMs),
        overdue: serverNowMs > due,
        blockers: i.blockers,
        readyTargetMissed: i.ready_target_missed,
      };
    })
    .sort((a, b) => Number(b.overdue) - Number(a.overdue) || a.dueAtMs - b.dueAtMs || a.id.localeCompare(b.id));
}

export type BreachStep = "triage" | "pdpc-notified" | "subjects-notified" | "close" | "done";

export interface BreachClockRow {
  readonly label: "triage" | "pdpc" | "subjects";
  readonly required: boolean;
  readonly met: boolean;
  readonly metLate: boolean;
  readonly dueAtMs: number | null;
  readonly clock: Countdown | null;
  readonly overdue: boolean;
}

export interface BreachRow {
  readonly id: string;
  readonly severity: string;
  readonly summary: string;
  readonly affected: number;
  readonly detectedAtMs: number;
  readonly clocks: readonly BreachClockRow[];
  readonly nextStep: BreachStep;
  readonly anyOverdue: boolean;
  readonly urgencyMs: number;
}

const CLOCK_LABELS = ["triage", "pdpc", "subjects"] as const;

export function nextBreachStep(b: BreachWire): BreachStep {
  if (b.closed_at !== null) return "done";
  if (b.triaged_at === null) return "triage";
  if (b.dpo_decision === "no_notification_required") return "close";
  if (b.pdpc_notified_at === null) return "pdpc-notified";
  if (b.subjects_notified_at === null) return "subjects-notified";
  return "close";
}

export function breachRow(b: BreachWire, serverNowMs: number): BreachRow {
  const clocks = CLOCK_LABELS.map((label): BreachClockRow => {
    const c = b.clocks[label];
    const due = c.due_at === null ? null : Date.parse(c.due_at);
    const met = c.status === "met" || c.status === "met_late";
    const pending = c.status === "pending" || c.status === "overdue";
    return {
      label,
      required: c.status !== "not_required",
      met,
      metLate: c.status === "met_late",
      dueAtMs: due,
      clock: due !== null && pending ? countdown(due, serverNowMs) : null,
      overdue: pending && due !== null && serverNowMs > due,
    };
  });
  const open = clocks.filter((c) => c.dueAtMs !== null && !c.met && c.required);
  const urgency = open.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...open.map((c) => (c.dueAtMs as number) - serverNowMs));
  return {
    id: b.id,
    severity: b.severity,
    summary: b.summary,
    affected: b.affected_count,
    detectedAtMs: Date.parse(b.detected_at),
    clocks,
    nextStep: nextBreachStep(b),
    anyOverdue: clocks.some((c) => c.overdue),
    urgencyMs: urgency,
  };
}

/** Open breaches first by urgency (overdue clocks at the top), closed ones last. */
export function breachRegister(items: readonly BreachWire[], serverNowMs: number): readonly BreachRow[] {
  return items
    .map((b) => breachRow(b, serverNowMs))
    .sort((a, b) => {
      const aDone = a.nextStep === "done" ? 1 : 0;
      const bDone = b.nextStep === "done" ? 1 : 0;
      return aDone - bDone || a.urgencyMs - b.urgencyMs || a.id.localeCompare(b.id);
    });
}
