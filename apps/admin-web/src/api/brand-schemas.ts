import { z } from "zod";

/** The review console ships these schemas to the browser; skip zod's `new Function` JIT probe, which a strict CSP reports as a violation. */
z.config({ jitless: true });

/** Wire schemas for the brand application review operations (docs/api/openapi.yaml, adminBrand* operations). */
const ts = z.iso.datetime({ offset: true });
const uuid = z.uuid();
const looseObject = z.record(z.string(), z.unknown());

export const BRAND_STATUSES = ["DRAFT", "SUBMITTED", "AUTO_CHECKS", "IN_REVIEW", "NEEDS_INFO", "APPROVED", "REJECTED", "SUSPENDED", "WITHDRAWN"] as const;
export const brandStatus = z.enum(BRAND_STATUSES);
export type BrandStatus = z.infer<typeof brandStatus>;
export const brandKind = z.enum(["local", "global"]);
export type BrandKind = z.infer<typeof brandKind>;

export const BRAND_REASON_CODES = [
  "ok", "ownership_not_proven", "documents_unreadable", "documents_inconsistent", "identity_mismatch", "domain_not_verified",
  "trademark_owner_mismatch", "not_a_brand", "prohibited_category", "counterfeit_confirmed", "sanctions_hit", "duplicate_claim",
  "incomplete_information", "other",
] as const;
export const brandReasonCode = z.enum(BRAND_REASON_CODES);
export type BrandReasonCode = z.infer<typeof brandReasonCode>;

export const DOCUMENT_READ_REASONS = ["kyc_review", "appeal_review", "fraud_investigation", "legal_request"] as const;
export type DocumentReadReason = (typeof DOCUMENT_READ_REASONS)[number];

export const CONFLICT_OUTCOMES = ["keep_first", "replace_with_this", "both_valid", "reject_all"] as const;
export type ConflictOutcome = (typeof CONFLICT_OUTCOMES)[number];

export const REQUESTED_ITEM_KINDS = ["document", "field", "domain_verification", "clarification"] as const;

export const requestedItem = z.object({
  code: z.string(),
  kind: z.enum(REQUESTED_ITEM_KINDS),
  message_ar: z.string(),
  message_en: z.string(),
  satisfied: z.boolean().optional(),
});
export type RequestedItemWire = z.infer<typeof requestedItem>;

export const brandDocument = z.object({
  id: uuid,
  requirement_code: z.string(),
  original_filename: z.string().optional(),
  content_type: z.enum(["application/pdf", "image/jpeg", "image/png"]),
  size_bytes: z.number().int(),
  upload_status: z.enum(["awaiting_upload", "uploaded", "expired"]),
  scan_status: z.enum(["pending", "clean", "infected", "error"]),
  review_status: z.enum(["unreviewed", "accepted", "rejected", "unreadable"]),
  review_note_public: z.string().nullable().optional(),
  created_at: ts,
});
export type BrandDocumentWire = z.infer<typeof brandDocument>;

export const trademarkEvidence = z.object({
  id: uuid,
  source: z.enum(["WIPO", "EUIPO", "USPTO", "EGYPT_TMO", "OTHER_NATIONAL", "MANUAL"]),
  register_number: z.string().optional(),
  found: z.boolean(),
  owner_name: z.string().optional(),
  status: z.string().optional(),
  classes: z.array(z.number().int()).optional(),
  owner_matches_applicant: z.enum(["yes", "no", "unknown"]).optional(),
  retrieved_at: ts,
});
export type TrademarkEvidenceWire = z.infer<typeof trademarkEvidence>;

export const AUTO_CHECK_CODES = [
  "document_scan", "ocr_extract", "field_consistency", "sanctions_screen", "trademark_register", "domain_verified",
  "duplicate_brand", "signatory_age", "iban_name_match", "risk_score",
] as const;
export const autoCheck = z.object({
  code: z.enum(AUTO_CHECK_CODES),
  result: z.enum(["pass", "warn", "fail", "skipped", "error"]),
  detail: z.string().optional(),
  ran_at: ts,
});
export type AutoCheckWire = z.infer<typeof autoCheck>;

const domainVerification = z.object({ status: z.string().optional(), method: z.string().optional(), verified_at: ts.nullable().optional() }).loose();

export const brandApplication = z.object({
  id: uuid,
  status: brandStatus,
  brand_kind: brandKind,
  country: z.string().regex(/^[A-Z]{2}$/),
  brand_name: z.string(),
  legal_name: z.string().optional(),
  registration: looseObject.optional(),
  trademark: looseObject.optional(),
  ownership_basis: z.string().optional(),
  website_domain: z.string().optional(),
  domain_verification: domainVerification.optional(),
  social_handles: looseObject.optional(),
  contact: looseObject.optional(),
  signatory_masked: looseObject.optional(),
  eta_registration: z.string().optional(),
  documents: z.array(brandDocument),
  requested_items: z.array(requestedItem),
  decision: z.unknown().optional(),
  decision_due_at: ts.nullable().optional(),
  store_id: uuid.nullable().optional(),
  appeal_used: z.boolean().optional(),
  submitted_at: ts.nullable().optional(),
  created_at: ts,
  updated_at: ts,
});
export type BrandApplicationWire = z.infer<typeof brandApplication>;

export const adminBrandApplication = z.object({
  application: brandApplication,
  assignee_id: uuid.nullable(),
  decision_due_at: ts,
  sla_breached: z.boolean().optional(),
  pending_cosign: z.boolean(),
  high_risk_country: z.boolean().optional(),
  auto_checks: z.array(autoCheck),
  trademark_evidence: z.array(trademarkEvidence).optional(),
  duplicate_claim_application_ids: z.array(uuid).optional(),
  internal_notes: z.array(z.object({ admin_id: uuid, note: z.string(), at: ts })).optional(),
  history: z.array(z.object({
    at: ts,
    actor_type: z.enum(["applicant", "admin", "system"]),
    event: z.string(),
    from_status: z.string().optional(),
    to_status: z.string().optional(),
  })),
});
export type AdminBrandApplicationWire = z.infer<typeof adminBrandApplication>;

export const adminBrandApplicationList = z.object({
  items: z.array(z.object({
    id: uuid,
    brand_name: z.string(),
    brand_kind: brandKind,
    country: z.string().regex(/^[A-Z]{2}$/),
    status: brandStatus,
    assignee_id: uuid.nullable().optional(),
    submitted_at: ts,
    decision_due_at: ts,
    sla_breached: z.boolean().optional(),
    appeal: z.boolean().optional(),
    high_risk_country: z.boolean().optional(),
    risk_score: z.number().int().min(0).max(100).optional(),
  })),
  page: z.object({ next_cursor: z.string().nullable(), has_more: z.boolean() }),
});
export type BrandQueueItemWire = z.infer<typeof adminBrandApplicationList>["items"][number];

export const documentReadUrl = z.object({ url: z.url(), expires_at: ts });
