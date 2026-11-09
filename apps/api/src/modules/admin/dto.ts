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
/** Execute takes no fields; an empty object keeps the mutating-route body rule. */
export const ApprovalExecuteInput = z.strictObject({});
export type ApprovalExecuteInput = z.infer<typeof ApprovalExecuteInput>;
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

// ---- KYC case detail (docs/api/openapi.yaml AdminKycCase). The signatory is stored as the 21+ result only (seller_signatories keeps no name, id or DOB),
// so `signatory` is null and `signatory_revealed` is never present: the reason-coded read is still logged in pii_access_log (it exposes bank-verification state and document pointers).
export const KYC_DOC_TYPES = ["commercial_register", "tax_card", "signatory_national_id", "iban_letter", "brand_authorization", "proof_of_purchase"] as const;
export const KycDocumentDto = z.strictObject({
  id: z.uuid(),
  doc_type: z.enum(KYC_DOC_TYPES),
  media_id: z.uuid(),
  verified: z.boolean(),
  expires_on: z.iso.date().nullable(),
  created_at: Iso,
});
export const KycCaseDetailDto = z.strictObject({
  id: z.uuid(),
  seller_id: z.uuid(),
  kind: z.string().max(500),
  status: z.enum(KYC_STATUSES),
  submitted_at: Iso.nullable(),
  decided_at: Iso.nullable(),
  decision_reason: z.string().max(500).nullable(),
  version: z.number().int().min(1),
  documents: z.array(KycDocumentDto).max(50),
  required_documents: z.array(z.string().max(500)).max(50),
  signatory: z.null(),
});
export const KycCheckDto = z.strictObject({
  check_type: z.string().max(500),
  result: z.string().max(500),
  score_bp: z.number().int().min(0).max(10000).nullable(),
  provider: z.string().max(500).nullable(),
  checked_at: Iso,
});
export const AdminKycCase = z.strictObject({
  case: KycCaseDetailDto,
  seller_legal: z.strictObject({
    legal_name_ar: z.string().min(1).max(500),
    legal_name_en: z.string().max(500).nullable(),
    commercial_register_no: z.string().max(500),
    tax_card_no: z.string().max(500),
    governorate_name_ar: z.string().min(1).max(500),
  }),
  checks: z.array(KycCheckDto).max(50),
});
export type AdminKycCase = z.infer<typeof AdminKycCase>;

// ---- roles (admin.rbac.read)
export const RolesQuery = CursorQuery;
export type RolesQuery = z.infer<typeof RolesQuery>;
export const RoleDto = z.strictObject({
  code: z.string().max(500),
  scope: z.enum(["admin", "seller"]),
  description: z.string().max(500),
  permissions: z.array(z.string().max(500)).max(50),
});
export type RoleDto = z.infer<typeof RoleDto>;
export const RolePage = pageOf(RoleDto);
export type RolePage = z.infer<typeof RolePage>;
