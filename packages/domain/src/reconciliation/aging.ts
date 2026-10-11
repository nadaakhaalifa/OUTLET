import { MS_PER_DAY } from "../payouts/cairo";
import type { Finding, FindingKind, Severity } from "./types";

/** T4: unmatched items older than 3 days escalate to Finance. */
export const ESCALATE_AFTER_MS = 3 * MS_PER_DAY;

export function severityOf(kind: FindingKind): Severity {
  switch (kind) {
    case "trial_balance":
    case "suite_failed":
      return "critical";
    case "amount_mismatch":
    case "duplicate_external":
    case "duplicate_internal":
    case "settlement_posting_mismatch":
    case "settlement_not_posted":
    case "file_rejected":
    case "store_credit_drift":
    case "store_credit_negative":
    case "eta_rejected":
      return "high";
    default:
      return "medium";
  }
}

/** Critical findings escalate at once; the rest when the item is strictly older than 3 days. */
export function shouldEscalate(f: Pick<Finding, "severity" | "atMs">, nowMs: number): boolean {
  return f.severity === "critical" || nowMs - f.atMs > ESCALATE_AFTER_MS;
}

export type TicketStatus = "open" | "escalated" | "resolved";

export interface TicketSnapshot {
  readonly status: TicketStatus;
  readonly firstSeenAtMs: number;
  readonly escalatedAtMs: number | null;
}

export interface TicketPlan {
  readonly opened: readonly Finding[];
  /** Newly escalated now (open before, or opened already escalated). */
  readonly escalated: readonly Finding[];
  /** Still present and unchanged in status. */
  readonly continuing: readonly Finding[];
  /** Dedupe keys of open or escalated tickets whose finding is gone. */
  readonly resolved: readonly string[];
  /** Final status for every finding, by dedupe key. */
  readonly statusByKey: ReadonlyMap<string, "open" | "escalated">;
}

/**
 * Pure ticket diff. `existing` holds the current tickets by dedupe key (any status). A finding
 * matching a resolved ticket reopens it. Escalation happens once: an already escalated ticket is
 * `continuing`. Findings are deduplicated by key first (first in key order wins), so the plan is
 * independent of finding order.
 */
export function planTickets(
  findings: readonly Finding[],
  existing: ReadonlyMap<string, TicketSnapshot>,
  nowMs: number,
): TicketPlan {
  const byKey = new Map<string, Finding>();
  // Same key, different details: the oldest item wins (aging is measured from it), then a total order.
  const order = (a: Finding, b: Finding): number =>
    a.dedupeKey < b.dedupeKey ? -1 : a.dedupeKey > b.dedupeKey ? 1 : a.atMs - b.atMs || (a.delta < b.delta ? -1 : a.delta > b.delta ? 1 : 0);
  for (const f of [...findings].sort(order)) {
    if (!byKey.has(f.dedupeKey)) byKey.set(f.dedupeKey, f);
  }
  const opened: Finding[] = [];
  const escalated: Finding[] = [];
  const continuing: Finding[] = [];
  const statusByKey = new Map<string, "open" | "escalated">();
  for (const [key, f] of byKey) {
    const prev = existing.get(key);
    const live = prev !== undefined && prev.status !== "resolved";
    const escalate = shouldEscalate(f, nowMs) || (live && prev.status === "escalated");
    statusByKey.set(key, escalate ? "escalated" : "open");
    if (!live) {
      opened.push(f);
      if (escalate) escalated.push(f);
    } else if (escalate && prev.status !== "escalated") {
      escalated.push(f);
    } else {
      continuing.push(f);
    }
  }
  const resolved = [...existing]
    .filter(([key, t]) => t.status !== "resolved" && !byKey.has(key))
    .map(([key]) => key)
    .sort();
  return { opened, escalated, continuing, resolved, statusByKey };
}
