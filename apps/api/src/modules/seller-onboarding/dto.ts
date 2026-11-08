import { z } from "zod";
import { CursorQuery, pageOf } from "../../platform/pagination.js";

const Iso = z.iso.datetime();
const Text = z.string().trim().min(1).max(200);
const Role = z.enum(["owner", "manager", "catalog", "warehouse", "finance", "support"]);

export const DOCUMENT_TYPES = ["commercial_register", "tax_card", "signatory_national_id", "iban_letter", "brand_authorization", "proof_of_purchase"] as const;

/** Applicant data as @outlet/seller-accounts models it (legal identity by governorate code and Arabic name; no store is created here). */
export const SellerOnboardingInput = z.strictObject({
  legal_type: z.enum(["company", "sole_trader"]),
  legal_name_ar: Text.optional(),
  legal_name_en: Text.optional(),
  commercial_register_no: Text.optional(),
  tax_card_no: Text.optional(),
  governorate_code: Text.optional(),
  governorate_name_ar: Text.optional(),
});
export type SellerOnboardingInput = z.infer<typeof SellerOnboardingInput>;
export const SellerOnboardingResult = z.strictObject({ seller_id: z.uuid(), kyc_case_id: z.uuid() });
export type SellerOnboardingResult = z.infer<typeof SellerOnboardingResult>;

export const SellerOnboarding = z.strictObject({
  seller_id: z.uuid(),
  kyc_case_id: z.uuid(),
  status: z.enum(["DRAFT", "SUBMITTED", "AUTO_CHECKS", "APPROVED", "NEEDS_INFO", "REJECTED", "SUSPENDED"]),
  submitted_at: Iso.nullable(),
  decided_at: Iso.nullable(),
  decision_reason: z.string().max(100).nullable(),
  version: z.number().int(),
  /** Stable codes of what still blocks submission (document:<kind>, bank_account, legal_name_ar, ...). Empty = complete. */
  gaps: z.array(z.string().max(100)).max(50),
  required_documents: z.array(z.enum(DOCUMENT_TYPES)).max(10),
});
export type SellerOnboarding = z.infer<typeof SellerOnboarding>;

/** Multipart form: `doc_type` (and optional `expires_on`) first, then the PDF `file`. */
export const DocumentUploadForm = z.strictObject({ doc_type: z.enum(DOCUMENT_TYPES), expires_on: z.iso.date().optional() });
export const DocumentUploadResult = z.strictObject({ document_id: z.uuid(), media_id: z.uuid(), doc_type: z.enum(DOCUMENT_TYPES) });
export type DocumentUploadResult = z.infer<typeof DocumentUploadResult>;

export const EmptyBody = z.strictObject({});

export const BankAccountInput = z.strictObject({ iban: z.string().trim().min(15).max(34), account_name: Text });
export type BankAccountInput = z.infer<typeof BankAccountInput>;
/** The IBAN is never echoed back: only its last four characters. */
export const BankAccountResult = z.strictObject({ iban_last4: z.string().length(4) });
export type BankAccountResult = z.infer<typeof BankAccountResult>;

export const StoreMember = z.strictObject({
  id: z.uuid(),
  user_id: z.uuid().nullable(),
  display_name: z.string().max(200).nullable(),
  role_code: Role,
  status: z.enum(["invited", "active", "suspended", "removed"]),
  joined_at: Iso.nullable(),
});
export type StoreMember = z.infer<typeof StoreMember>;
export const StoreMemberPage = pageOf(StoreMember);
export type StoreMemberPage = z.infer<typeof StoreMemberPage>;
export const MembersQuery = CursorQuery;
export type MembersQuery = z.infer<typeof MembersQuery>;

/** `contact` is an E.164 phone (leading +) or an email; the owner role cannot be invited. */
export const StoreInviteInput = z.strictObject({ contact: z.string().trim().min(5).max(254), role_code: z.enum(["manager", "catalog", "warehouse", "finance", "support"]) });
export type StoreInviteInput = z.infer<typeof StoreInviteInput>;
export const StoreInvite = z.strictObject({ id: z.uuid(), role_code: Role, expires_at: Iso });
export type StoreInvite = z.infer<typeof StoreInvite>;
