import { z } from "zod";
import { MoneyDto } from "../../platform/money-wire.js";
import { CursorQuery, pageOf } from "../../platform/pagination.js";

const Iso = z.iso.datetime();

// ---- approval requests (docs/api/openapi.yaml ApprovalRequest, ApprovalDecisionInput)
export const APPROVAL_STATUSES = ["PENDING", "APPROVED", "EXECUTED", "REJECTED", "EXPIRED"] as const;
export const ApprovalIdParams = z.strictObject({ approval_request_id: z.uuid() });
export type ApprovalIdParams = z.infer<typeof ApprovalIdParams>;
export const ApprovalsQuery = CursorQuery.extend({ status: z.enum(APPROVAL_STATUSES).optional(), action: z.string().min(1).max(200).optional() });
export type ApprovalsQuery = z.infer<typeof ApprovalsQuery>;
export const ApprovalDecisionInput = z.strictObject({ decision: z.enum(["approve", "reject"]), reason: z.string().trim().min(3).max(2000) });
export type ApprovalDecisionInput = z.infer<typeof ApprovalDecisionInput>;
export const ApprovalRequestDto = z.strictObject({
  id: z.uuid(),
  action: z.string().max(500),
  target_type: z.string().max(500),
  target_id: z.string().max(500),
  requested_by: z.uuid(),
  status: z.enum(APPROVAL_STATUSES),
  created_at: Iso,
  expires_at: Iso,
  decided_by: z.uuid().nullable(),
  decided_at: Iso.nullable(),
  reason: z.string().max(500).nullable(),
});
export type ApprovalRequestDto = z.infer<typeof ApprovalRequestDto>;
export const ApprovalRequestPage = pageOf(ApprovalRequestDto);
export type ApprovalRequestPage = z.infer<typeof ApprovalRequestPage>;

// ---- KYC cases
export const KYC_STATUSES = ["SUBMITTED", "AUTO_CHECKS", "APPROVED", "NEEDS_INFO", "REJECTED", "SUSPENDED"] as const;
export const KycCaseIdParams = z.strictObject({ kyc_case_id: z.uuid() });
export type KycCaseIdParams = z.infer<typeof KycCaseIdParams>;
export const KycCasesQuery = CursorQuery.extend({ status: z.enum(KYC_STATUSES).optional() });
export type KycCasesQuery = z.infer<typeof KycCasesQuery>;
export const KycCaseSummary = z.strictObject({
  id: z.uuid(),
  seller_id: z.uuid(),
  legal_name_ar: z.string().max(500),
  status: z.enum(KYC_STATUSES),
  submitted_at: Iso.nullable(),
});
export const KycCaseSummaryPage = pageOf(KycCaseSummary);
export type KycCaseSummaryPage = z.infer<typeof KycCaseSummaryPage>;
export const KycDecisionInput = z.strictObject({
  decision: z.enum(["APPROVED", "NEEDS_INFO", "REJECTED"]),
  decision_reason: z.string().trim().min(3).max(1800),
  requested_documents: z.array(z.string().regex(/^[a-z_]{3,40}$/)).max(20).optional(),
});
export type KycDecisionInput = z.infer<typeof KycDecisionInput>;
/** Result of a decision: the case header only (documents and the masked signatory stay behind the reason-coded detail route, not built yet). */
export const KycDecisionResult = z.strictObject({
  id: z.uuid(),
  seller_id: z.uuid(),
  status: z.enum(KYC_STATUSES),
  submitted_at: Iso.nullable(),
  decided_at: Iso.nullable(),
  decision_reason: z.string().max(500).nullable(),
  version: z.number().int().min(1),
});
export type KycDecisionResult = z.infer<typeof KycDecisionResult>;

// ---- reconciliation (read side)
export const RunIdParams = z.strictObject({ reconciliation_run_id: z.uuid() });
export type RunIdParams = z.infer<typeof RunIdParams>;
export const RunsQuery = CursorQuery.extend({ source: z.string().min(1).max(60).optional(), business_date: z.iso.date().optional() });
export type RunsQuery = z.infer<typeof RunsQuery>;
export const ReconciliationRunDto = z.strictObject({
  id: z.uuid(),
  source: z.string().max(60),
  counterparty: z.string().max(500),
  business_date: z.iso.date(),
  mode: z.enum(["nightly", "intraday", "manual"]),
  status: z.enum(["RUNNING", "COMPLETED", "FAILED"]),
  matched_count: z.number().int().min(0),
  unmatched_count: z.number().int().min(0),
  started_at: Iso,
  finished_at: Iso.nullable(),
});
export type ReconciliationRunDto = z.infer<typeof ReconciliationRunDto>;
export const ReconciliationRunPage = pageOf(ReconciliationRunDto);
export type ReconciliationRunPage = z.infer<typeof ReconciliationRunPage>;
export const ItemsQuery = CursorQuery;
export type ItemsQuery = z.infer<typeof ItemsQuery>;
export const ReconciliationItemDto = z.strictObject({
  id: z.uuid(),
  run_id: z.uuid(),
  source_ref_type: z.string().max(500),
  source_ref_id: z.uuid().nullable(),
  entry_id: z.uuid().nullable(),
  expected: MoneyDto.nullable(),
  actual: MoneyDto.nullable(),
  status: z.enum(["UNMATCHED", "AMOUNT_MISMATCH", "MISSING_LEDGER", "MISSING_SOURCE", "RESOLVED"]),
  ticket_ref: z.string().max(500).nullable(),
  first_seen_at: Iso,
  resolved_at: Iso.nullable(),
  age_days: z.number().int().min(0),
});
export type ReconciliationItemDto = z.infer<typeof ReconciliationItemDto>;
export const ReconciliationItemPage = pageOf(ReconciliationItemDto);
export type ReconciliationItemPage = z.infer<typeof ReconciliationItemPage>;
