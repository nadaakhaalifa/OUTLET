import { ADMIN_ROLES } from "@outlet/policy";
import { z } from "zod";
import { CursorQuery, pageOf } from "../../platform/pagination.js";

const Iso = z.iso.datetime();
const MarketIdWire = z.string().regex(/^[A-Z]{2}(-[A-Z0-9]{2,3})?$/);

// ---- feature flags and kill switches (docs/api/openapi.yaml FeatureFlag, KillSwitchInput)
export const FlagsQuery = CursorQuery;
export type FlagsQuery = z.infer<typeof FlagsQuery>;
export const FlagKeyParams = z.strictObject({ flag_key: z.string().regex(/^[a-z0-9_.-]{3,64}$/) });
export type FlagKeyParams = z.infer<typeof FlagKeyParams>;
export const FlagRuleDto = z.strictObject({
  id: z.uuid(),
  market_id: MarketIdWire.nullable(),
  enabled: z.boolean(),
  variant: z.record(z.string(), z.unknown()),
  version: z.number().int().min(1),
});
export const FeatureFlagDto = z.strictObject({
  key: z.string().max(500),
  kind: z.enum(["release", "experiment", "kill_switch", "ops"]),
  description: z.string().max(500),
  fail_mode: z.enum(["closed", "open"]),
  rules: z.array(FlagRuleDto).max(50),
});
export type FeatureFlagDto = z.infer<typeof FeatureFlagDto>;
export const FeatureFlagPage = pageOf(FeatureFlagDto);
export type FeatureFlagPage = z.infer<typeof FeatureFlagPage>;
/** `enabled` is the feature's state (FlagRule.enabled): false engages the kill switch (feature off), true releases it. */
export const KillSwitchInput = z.strictObject({ enabled: z.boolean(), reason: z.string().trim().min(3).max(2000) });
export type KillSwitchInput = z.infer<typeof KillSwitchInput>;

// ---- audit log (docs/api/openapi.yaml AuditLogEntry): list only, diff bodies are never returned
export const AuditQuery = CursorQuery.extend({
  actor_id: z.uuid().optional(),
  target_type: z.string().min(1).max(200).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});
export type AuditQuery = z.infer<typeof AuditQuery>;
export const AuditLogEntryDto = z.strictObject({
  id: z.uuid(),
  actor_type: z.string().max(500),
  actor_id: z.uuid().nullable(),
  action: z.string().max(500),
  target_type: z.string().max(500),
  target_id: z.string().max(500),
  reason_code: z.string().max(500).nullable(),
  request_id: z.string().max(500),
  occurred_at: Iso,
});
export type AuditLogEntryDto = z.infer<typeof AuditLogEntryDto>;
export const AuditLogEntryPage = pageOf(AuditLogEntryDto);
export type AuditLogEntryPage = z.infer<typeof AuditLogEntryPage>;

// ---- audit-log chain verification (new contract operation adminVerifyAuditLog)
export const AuditVerifyQuery = z.strictObject({ from_seq: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional() });
export type AuditVerifyQuery = z.infer<typeof AuditVerifyQuery>;
/** A broken chain is a successful answer (`ok: false` + where it broke), not an error. */
export const AuditVerifyResult = z.strictObject({
  ok: z.boolean(),
  checked: z.number().int().min(0),
  head_seq: z.number().int().min(1).nullable(),
  broken_seq: z.number().int().min(1).nullable(),
  reason: z.enum(["hash", "link", "gap", "market"]).nullable(),
});
export type AuditVerifyResult = z.infer<typeof AuditVerifyResult>;

// ---- just-in-time elevations (new contract operations adminListElevations, adminRequestElevation, adminDecideElevation)
export const ELEVATION_STATUSES = ["PENDING", "APPROVED", "REJECTED", "EXPIRED"] as const;
export const ElevationIdParams = z.strictObject({ elevation_id: z.uuid() });
export type ElevationIdParams = z.infer<typeof ElevationIdParams>;
export const ElevationsQuery = CursorQuery.extend({ status: z.enum(ELEVATION_STATUSES).optional() });
export type ElevationsQuery = z.infer<typeof ElevationsQuery>;
export const ElevationRequestInput = z.strictObject({
  role: z.enum(ADMIN_ROLES),
  reason: z.string().trim().min(3).max(500),
  ttl_minutes: z.number().int().min(1).max(60),
});
export type ElevationRequestInput = z.infer<typeof ElevationRequestInput>;
/** `super_admin` has no single-approver path: approve answers 409 `dual-approval-required`; it activates through its approval request (`approval_request_id`). */
export const ElevationDecisionInput = z.strictObject({ decision: z.enum(["approve", "reject"]) });
export type ElevationDecisionInput = z.infer<typeof ElevationDecisionInput>;
export const ElevationDto = z.strictObject({
  id: z.uuid(),
  staff_id: z.uuid(),
  role: z.enum(ADMIN_ROLES),
  reason: z.string().max(500),
  ttl_minutes: z.number().int().min(1).max(60),
  status: z.enum(ELEVATION_STATUSES),
  created_at: Iso,
  pending_until: Iso,
  decided_at: Iso.nullable(),
  starts_at: Iso.nullable(),
  expires_at: Iso.nullable(),
  approved_by: z.uuid().nullable(),
  approval_request_id: z.uuid().nullable(),
});
export type ElevationDto = z.infer<typeof ElevationDto>;
export const ElevationPage = pageOf(ElevationDto);
export type ElevationPage = z.infer<typeof ElevationPage>;

// ---- PII access log (docs/api/openapi.yaml adminListPiiAccessLog): ids and reason codes only, never the data that was viewed
export const PiiAccessLogQuery = CursorQuery.extend({
  staff_id: z.uuid().optional(),
  target_type: z.string().min(1).max(200).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});
export type PiiAccessLogQuery = z.infer<typeof PiiAccessLogQuery>;
export const PiiAccessLogEntryDto = z.strictObject({
  id: z.uuid(),
  staff_id: z.string().max(500),
  action: z.string().max(500),
  target_type: z.string().max(500),
  target_id: z.string().max(500),
  reason_code: z.string().max(500),
  request_id: z.string().max(500).nullable(),
  occurred_at: Iso,
});
export type PiiAccessLogEntryDto = z.infer<typeof PiiAccessLogEntryDto>;
export const PiiAccessLogEntryPage = pageOf(PiiAccessLogEntryDto);
export type PiiAccessLogEntryPage = z.infer<typeof PiiAccessLogEntryPage>;

// ---- store moderation (adminSuspendStore, adminReinstateStore): always dual approval, so the first call files the request (409 dual-approval-required)
export const STORE_SUSPEND_REASONS = ["price_fraud", "counterfeit", "kyc_failure", "policy_violation", "customer_safety", "legal_order"] as const;
export const STORE_REINSTATE_REASONS = ["appeal_upheld", "issue_resolved", "error_corrected"] as const;
export const StoreIdParams = z.strictObject({ store_id: z.uuid() });
export type StoreIdParams = z.infer<typeof StoreIdParams>;
export const StoreSuspendInput = z.strictObject({ reason_code: z.enum(STORE_SUSPEND_REASONS), note: z.string().trim().min(3).max(2000), finding_id: z.uuid().optional() });
export type StoreSuspendInput = z.infer<typeof StoreSuspendInput>;
export const StoreReinstateInput = z.strictObject({ reason_code: z.enum(STORE_REINSTATE_REASONS), note: z.string().trim().min(3).max(2000) });
export type StoreReinstateInput = z.infer<typeof StoreReinstateInput>;
