import type { ConsentRecord } from "@outlet/privacy";
import type { BreachEntry, DeletionRequest, ExportRequest } from "./bridge";
import type { OutboxDraft } from "./ports";

type Payload = OutboxDraft["payload"];

const draft = (
  id: string,
  type: string,
  aggregateType: string,
  aggregateId: string,
  occurredAtMs: number,
  payload: Payload,
): OutboxDraft => ({ id, type, aggregateType, aggregateId, occurredAtMs, payload });

/** Event builders. Payloads carry identifiers and codes only: no names, contact data or measurements. */
export const privacyEvents = {
  consentChanged: (id: string, userId: string, records: readonly ConsentRecord[], at: number): OutboxDraft =>
    draft(id, "consent.changed", "user", userId, at, {
      user_id: userId,
      changes: records.map((r) => `${r.purpose}:${r.granted ? "granted" : "withdrawn"}@v${r.version}`).join(","),
    }),
  exportRequested: (id: string, r: ExportRequest, at: number): OutboxDraft =>
    draft(id, "privacy.export_requested", "dsar_request", r.id, at, {
      request_id: r.id,
      user_id: r.userId,
      locale: r.locale,
      ready_target_at_ms: r.readyTargetAtMs,
    }),
  exportReady: (id: string, r: ExportRequest, at: number): OutboxDraft =>
    draft(id, "privacy.export_ready", "dsar_request", r.id, at, {
      request_id: r.id,
      user_id: r.userId,
      locale: r.locale,
      artifact_expires_at_ms: r.artifactExpiresAtMs,
    }),
  exportFailed: (id: string, r: ExportRequest, at: number): OutboxDraft =>
    draft(id, "privacy.export_failed", "dsar_request", r.id, at, {
      request_id: r.id,
      user_id: r.userId,
      failure_code: r.failureCode,
      attempts: r.attempts,
      terminal: r.status === "failed",
    }),
  deletionRequested: (id: string, r: DeletionRequest, at: number): OutboxDraft =>
    draft(id, "privacy.deletion_requested", "dsar_request", r.id, at, {
      request_id: r.id,
      user_id: r.userId,
      cooling_ends_at_ms: r.coolingEndsAtMs,
      forfeited_credit_minor: r.forfeitedCreditMinor.toString(),
    }),
  deletionCancelled: (id: string, r: DeletionRequest, at: number): OutboxDraft =>
    draft(id, "privacy.deletion_cancelled", "dsar_request", r.id, at, { request_id: r.id, user_id: r.userId }),
  deletionOnHold: (id: string, r: DeletionRequest, at: number): OutboxDraft =>
    draft(id, "privacy.deletion_on_hold", "dsar_request", r.id, at, {
      request_id: r.id,
      user_id: r.userId,
      blockers: r.blockers.map((b) => `${b.kind}:${b.count}`).join(","),
    }),
  deletionCompleted: (id: string, r: DeletionRequest, at: number): OutboxDraft =>
    draft(id, "privacy.deletion_completed", "dsar_request", r.id, at, { request_id: r.id, user_id: r.userId }),
  deletionErasureFailed: (id: string, r: DeletionRequest, at: number): OutboxDraft =>
    draft(id, "privacy.deletion_erasure_failed", "dsar_request", r.id, at, {
      request_id: r.id,
      user_id: r.userId,
      attempts: r.attempts,
      failure_code: r.failureCode,
      parked: r.status === "on_hold",
    }),
  breachRecorded: (id: string, b: BreachEntry, at: number): OutboxDraft =>
    draft(id, "privacy.breach_recorded", "breach", b.id, at, {
      breach_id: b.id,
      severity: b.severity,
      detected_at_ms: b.detectedAtMs,
    }),
  breachAdvanced: (id: string, b: BreachEntry, at: number): OutboxDraft =>
    draft(id, `privacy.breach_${b.status}`, "breach", b.id, at, { breach_id: b.id, status: b.status }),
};
