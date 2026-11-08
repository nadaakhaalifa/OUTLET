import { z } from "zod";

/** Zod mirrors of the docs/api/openapi.yaml admin schemas, trimmed to the fields the consoles read. */
const page = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), next_cursor: z.string().nullable().optional() });
const ts = z.string();
const MoneyWire = z.object({ amount_minor: z.string(), currency: z.string() });

export const KycSummary = z.object({ id: z.uuid(), seller_id: z.uuid(), legal_name_ar: z.string(), status: z.string(), submitted_at: ts.nullable().optional() });
export const KycSummaryPage = page(KycSummary);

const KycDocument = z.object({ id: z.uuid(), doc_type: z.string(), media_id: z.uuid(), verified: z.boolean(), expires_on: z.string().nullable().optional(), created_at: ts });
export const KycCase = z.object({
  case: z.object({
    id: z.uuid(),
    seller_id: z.uuid(),
    kind: z.string(),
    status: z.string(),
    decided_at: ts.nullable().optional(),
    decision_reason: z.string().nullable().optional(),
    version: z.number(),
    documents: z.array(KycDocument),
    required_documents: z.array(z.string()),
    signatory: z.object({ full_name_masked: z.string(), national_id_last4: z.string(), role_title: z.string().nullable().optional() }).nullable().optional(),
  }),
  seller_legal: z.object({ legal_name_ar: z.string(), legal_name_en: z.string().nullable().optional(), commercial_register_no: z.string(), tax_card_no: z.string(), governorate_name_ar: z.string() }),
  checks: z.array(z.object({ check_type: z.string(), result: z.string(), provider: z.string().nullable().optional(), checked_at: ts })),
  signatory_revealed: z.object({ full_name: z.string(), national_id: z.string(), phone_e164: z.string() }).partial().nullable().optional(),
});
export type KycCaseView = z.infer<typeof KycCase>;
export const SignedUrl = z.object({ url: z.url(), expires_at: ts.optional() });

export const EnforcementAction = z.object({
  id: z.uuid(), store_id: z.uuid(), action: z.string(), starts_at: ts, expires_at: ts.nullable().optional(), status: z.string(), human_review_required: z.boolean(), reviewed_at: ts.nullable().optional(),
});
export const EnforcementPage = page(EnforcementAction);
export const AdminFinding = z.object({ finding: z.object({ id: z.uuid(), rule: z.string(), severity: z.string(), status: z.string(), detected_at: ts }), store_id: z.uuid() });
export const FindingPage = page(AdminFinding);
export const PriceTrust = z.object({ store_id: z.uuid(), score: z.number(), violations_90d: z.number(), computed_at: ts });

export const ReconRun = z.object({
  id: z.uuid(), source: z.string(), counterparty: z.string(), business_date: z.string(), mode: z.string(), status: z.string(), matched_count: z.number(), unmatched_count: z.number(), started_at: ts,
});
export const ReconRunPage = page(ReconRun);
export const ReconItem = z.object({
  id: z.uuid(), run_id: z.uuid(), source_ref_type: z.string(), source_ref_id: z.string().nullable().optional(), expected: MoneyWire.nullable().optional(), actual: MoneyWire.nullable().optional(),
  status: z.string(), ticket_ref: z.string().nullable().optional(), first_seen_at: ts, age_days: z.number(),
});
export const ReconItemPage = page(ReconItem);

export const ApprovalRequest = z.object({ id: z.uuid(), action: z.string(), target_type: z.string(), target_id: z.string(), requested_by: z.uuid(), status: z.string(), created_at: ts, expires_at: ts });
export const ApprovalPage = page(ApprovalRequest);

export const PrivacyRequest = z.object({
  id: z.uuid(), subject_ref: z.string(), kind: z.string(), status: z.string(), blocked_reason: z.string().nullable().optional(), due_at: ts, completed_at: ts.nullable().optional(), created_at: ts,
});
export const PrivacyPage = page(PrivacyRequest);
export const ConsentStats = z.object({ as_of: ts, purposes: z.array(z.object({ purpose_code: z.string(), purpose_version: z.number(), granted_count: z.number(), withdrawn_30d: z.number() })) });
export const Breach = z.object({ id: z.uuid(), detected_at: ts, severity: z.string(), summary: z.string(), status: z.string(), pdpc_deadline_at: ts.nullable().optional() });
export const BreachPage = page(Breach);
export const Transfer = z.object({ id: z.uuid(), processor_code: z.string(), destination_country: z.string(), mechanism: z.string(), status: z.string(), valid_until: z.string().nullable().optional() });
export const TransferPage = page(Transfer);

export const AuditEntry = z.object({
  id: z.uuid(), actor_type: z.string(), actor_id: z.string().nullable().optional(), action: z.string(), target_type: z.string(), target_id: z.string(), reason_code: z.string().nullable().optional(), request_id: z.string(), occurred_at: ts,
});
export const AuditPage = page(AuditEntry);
