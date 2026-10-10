import { sha256Hex } from "@outlet/idempotency";
import type {
  BreachClocks,
  BreachEntry,
  ClockView,
  DeletionRequest,
  DsarQueue,
  ExportRequest,
} from "../domain/bridge";
import { DELETION_BLOCKER_MESSAGES } from "../domain/bridge";
import type { SignedUrl } from "../domain/ports";

const iso = (ms: number): string => new Date(ms).toISOString();
const isoOrNull = (ms: number | null): string | null => (ms === null ? null : iso(ms));

/** Wire status names follow docs/api/openapi.yaml PrivacyExport (queued, building, ready, expired, failed). */
const EXPORT_STATUS = {
  requested: "queued",
  collecting: "building",
  ready: "ready",
  expired: "expired",
  failed: "failed",
} as const;

export function exportWire(r: ExportRequest, download: SignedUrl | null) {
  return {
    id: r.id,
    status: EXPORT_STATUS[r.status],
    requested_at: iso(r.requestedAtMs),
    ready_at: isoOrNull(r.completedAtMs),
    download_url: download === null ? null : download.url,
    download_expires_at: download === null ? null : iso(download.expiresAtMs),
    // Additions to the OpenAPI skeleton (documented in docs/specs/privacy-center.md).
    locale: r.locale,
    ready_target_at: iso(r.readyTargetAtMs),
  };
}

const BLOCKER_CODE = { open_orders: "open_order", open_returns: "open_return", open_disputes: "open_dispute" } as const;

export function deletionWire(r: DeletionRequest) {
  return {
    id: r.id,
    // OpenAPI PrivacyDeletion calls the cooling state cooling_off; on_hold and erasing are additions.
    status: r.status === "cooling" ? "cooling_off" : r.status,
    requested_at: iso(r.requestedAtMs),
    cooling_off_ends_at: iso(r.coolingEndsAtMs),
    blockers: r.blockers.map((b) => ({
      code: BLOCKER_CODE[b.kind],
      count: b.count,
      message: DELETION_BLOCKER_MESSAGES[b.kind],
    })),
    store_credit_balance:
      r.forfeitedCreditMinor > 0n ? { amount: r.forfeitedCreditMinor.toString(), currency: "EGP" } : null,
    cancelled_at: isoOrNull(r.cancelledAtMs),
    completed_at: isoOrNull(r.completedAtMs),
  };
}

/** Pseudonymous subject reference for the DPO list. The raw user id is only shown in an audited, reason-coded view. */
export const subjectRef = (userId: string): string => `subj_${sha256Hex(`dsar-subject:v1:${userId}`).slice(0, 24)}`;

export function queueWire(q: DsarQueue) {
  return {
    summary: {
      open: q.summary.open,
      overdue: q.summary.overdue,
      due_within_24h: q.summary.dueWithin24h,
      by_kind: q.summary.byKind,
    },
    next_cursor: null,
    items: q.items.map((i) => ({
      id: i.id,
      type: i.kind === "delete" ? "deletion" : "export",
      subject_ref: subjectRef(i.userId),
      status: i.status,
      received_at: iso(i.requestedAtMs),
      due_at: iso(i.dueAtMs),
      ms_remaining: i.msRemaining,
      overdue: i.overdue,
      ready_target_at: isoOrNull(i.readyTargetAtMs),
      ready_target_missed: i.readyTargetMissed,
      cooling_ends_at: isoOrNull(i.coolingEndsAtMs),
      blockers: i.blockerKinds,
    })),
  };
}

const clockWire = (c: ClockView) => ({
  due_at: isoOrNull(c.dueAtMs),
  status: c.status,
  ms_remaining: c.msRemaining,
});

export function breachWire(b: BreachEntry, clocks: BreachClocks) {
  return {
    id: b.id,
    detected_at: iso(b.detectedAtMs),
    severity: b.severity,
    summary: b.summary,
    affected_count: b.affectedCount,
    status: b.status,
    dpo_decision: b.dpoDecision,
    triaged_at: isoOrNull(b.triagedAtMs),
    pdpc_notified_at: isoOrNull(b.pdpcNotifiedAtMs),
    subjects_notified_at: isoOrNull(b.subjectsNotifiedAtMs),
    closed_at: isoOrNull(b.closedAtMs),
    clocks: { triage: clockWire(clocks.triage), pdpc: clockWire(clocks.pdpc), subjects: clockWire(clocks.subjects) },
  };
}
