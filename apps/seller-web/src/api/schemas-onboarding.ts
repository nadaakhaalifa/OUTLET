import { z } from "zod";

/** Wire schemas for seller auth, brand onboarding and store settings (docs/specs/brand-onboarding-contract.md, seller-settings.md). */

export const brandKind = z.enum(["local", "global"]);
export type BrandKind = z.infer<typeof brandKind>;

export const applicationStatus = z.enum([
  "DRAFT", "SUBMITTED", "AUTO_CHECKS", "IN_REVIEW", "NEEDS_INFO", "APPROVED", "REJECTED", "SUSPENDED", "WITHDRAWN",
]);
export type ApplicationStatus = z.infer<typeof applicationStatus>;

export const sellerRole = z.enum(["owner", "manager", "catalog", "warehouse", "finance", "support"]);
export type SellerRole = z.infer<typeof sellerRole>;

const money = z.object({ amount: z.string().regex(/^\d{1,12}$/), currency: z.literal("EGP") });
export type Money = z.infer<typeof money>;

/* ------------------------------- auth ------------------------------- */
export const otpChallenge = z.object({ challenge_id: z.uuid(), expires_in: z.number().int(), resend_after: z.number().int() });
export const otpVerified = z.object({
  enrol_token: z.string().min(1),
  otp_proof: z.string().optional(),
  expires_in: z.number().int(),
  strong_factor_enrolled: z.boolean(),
  next_step: z.enum(["enrol_strong_factor", "assert_strong_factor"]),
});
export type OtpVerified = z.infer<typeof otpVerified>;

export const webauthnOptions = z.object({ challenge_id: z.uuid(), public_key: z.record(z.string(), z.unknown()) });
export type WebauthnOptions = z.infer<typeof webauthnOptions>;

export const sellerSessionTokens = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int(),
  seller_user_id: z.uuid(),
  amr: z.array(z.enum(["otp", "webauthn", "totp"])),
  memberships: z.array(z.object({ store_id: z.uuid(), role: sellerRole })),
});
export type SellerSessionTokens = z.infer<typeof sellerSessionTokens>;

export const totpEnrol = z.object({ otpauth_uri: z.string().min(1), recovery_codes: z.array(z.string()).min(1) });
export type TotpEnrol = z.infer<typeof totpEnrol>;

export const sellerMe = z.object({ user_id: z.uuid(), memberships: z.array(z.object({ store_id: z.uuid(), role: sellerRole })) });
export type SellerMe = z.infer<typeof sellerMe>;

/* ------------------------------- applications ------------------------------- */
export const fieldFormat = z.enum([
  "text", "national_id", "commercial_register_no", "tax_card_no", "company_reg_no", "vat_id", "url", "domain", "handle", "phone", "email", "country", "date",
]);
export type FieldFormat = z.infer<typeof fieldFormat>;

export const requirements = z.object({
  kind: brandKind,
  country: z.string(),
  version: z.number().int(),
  fields: z.array(z.object({
    code: z.string(), label_ar: z.string(), label_en: z.string(), required: z.boolean(), format: fieldFormat,
    pattern: z.string().optional(), min_signatory_age: z.number().int().optional(),
  })),
  documents: z.array(z.object({
    code: z.string(), label_ar: z.string(), label_en: z.string(), required: z.boolean(), one_of_group: z.string().optional(),
    accepts: z.array(z.enum(["pdf", "jpg", "png"])), max_bytes: z.number().int().default(10_485_760),
    help_ar: z.string().optional(), help_en: z.string().optional(),
  })),
  website_verification: z.enum(["required_if_website", "required", "optional"]),
  eta_registration_asked: z.boolean().optional(),
});
export type Requirements = z.infer<typeof requirements>;

const domainVerification = z.object({
  method: z.enum(["dns_txt", "email"]),
  domain: z.string(),
  status: z.enum(["pending", "verified", "failed", "expired"]),
  txt_record_name: z.string().optional(),
  txt_record_value: z.string().optional(),
  email_sent_to_masked: z.string().optional(),
  expires_at: z.string().optional(),
  verified_at: z.string().nullish(),
});
export type DomainVerification = z.infer<typeof domainVerification>;
export { domainVerification };

export const applicationDocument = z.object({
  id: z.uuid(),
  requirement_code: z.string(),
  original_filename: z.string().optional(),
  content_type: z.enum(["application/pdf", "image/jpeg", "image/png"]),
  size_bytes: z.number().int(),
  upload_status: z.enum(["awaiting_upload", "uploaded", "expired"]),
  scan_status: z.enum(["pending", "clean", "infected", "error"]),
  review_status: z.enum(["unreviewed", "accepted", "rejected", "unreadable"]),
  review_note_public: z.string().nullish(),
  created_at: z.string(),
});
export type ApplicationDocument = z.infer<typeof applicationDocument>;

export const decisionReason = z.enum([
  "ok", "ownership_not_proven", "documents_unreadable", "documents_inconsistent", "identity_mismatch", "domain_not_verified",
  "trademark_owner_mismatch", "not_a_brand", "prohibited_category", "counterfeit_confirmed", "sanctions_hit", "duplicate_claim",
  "incomplete_information", "other",
]);
export type DecisionReason = z.infer<typeof decisionReason>;

export const applicationAction = z.enum(["edit", "submit", "resubmit", "withdraw", "appeal", "upload_document", "verify_domain"]);
export type ApplicationAction = z.infer<typeof applicationAction>;

const requestedItem = z.object({
  code: z.string(), kind: z.enum(["document", "field", "domain_verification", "clarification"]),
  message_ar: z.string(), message_en: z.string(), satisfied: z.boolean().optional(),
});
export type RequestedItem = z.infer<typeof requestedItem>;

export const application = z.object({
  id: z.uuid(),
  status: applicationStatus,
  brand_kind: brandKind,
  country: z.string(),
  brand_name: z.string(),
  legal_name: z.string().optional(),
  registration: z.record(z.string(), z.unknown()).optional(),
  trademark: z.record(z.string(), z.unknown()).optional(),
  ownership_basis: z.string().optional(),
  website_domain: z.string().optional(),
  domain_verification: domainVerification.optional(),
  social_handles: z.record(z.string(), z.unknown()).optional(),
  contact: z.record(z.string(), z.unknown()).optional(),
  signatory_masked: z.record(z.string(), z.unknown()).optional(),
  eta_registration: z.string().optional(),
  documents: z.array(applicationDocument),
  requested_items: z.array(requestedItem),
  decision: z.object({
    decision: z.enum(["approved", "rejected", "needs_info"]),
    reason_code: decisionReason,
    message_ar: z.string(),
    message_en: z.string(),
    decided_at: z.string(),
    reapply_after: z.string().nullish(),
    appeal_allowed: z.boolean().optional(),
  }).nullish(),
  decision_due_at: z.string().nullish(),
  store_id: z.uuid().nullish(),
  allowed_actions: z.array(applicationAction),
  appeal_used: z.boolean().optional(),
  submitted_at: z.string().nullish(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Application = z.infer<typeof application>;

export const applicationPage = z.object({ items: z.array(application), page: z.object({ next_cursor: z.string().nullish() }).optional() });

export const documentUpload = z.object({
  document_id: z.uuid(),
  upload_url: z.url(),
  upload_method: z.literal("PUT"),
  upload_headers: z.record(z.string(), z.string()).default({}),
  expires_at: z.string(),
});
export type DocumentUpload = z.infer<typeof documentUpload>;

export const checklistCode = z.enum([
  "complete_store_profile", "add_english_store_name", "add_payout_iban", "enrol_eta_receipts", "add_first_product", "set_shipping_origin", "invite_team",
]);
export type ChecklistCode = z.infer<typeof checklistCode>;
export const checklist = z.object({
  store_id: z.uuid(),
  items: z.array(z.object({ code: checklistCode, done: z.boolean(), required_for_publish: z.boolean() })),
});
export type Checklist = z.infer<typeof checklist>;

/** Body of PATCH /v1/seller/applications/{id}; every key optional. */
export interface ApplicationPatch {
  brand_name?: string;
  legal_name?: string;
  registration?: { commercial_register_no?: string; tax_card_no?: string; company_reg_no?: string; company_reg_country?: string; vat_or_tax_id?: string };
  trademark?: { register?: string; number?: string; owner_name?: string };
  ownership_basis?: "brand_owner" | "authorized_distributor" | "third_party_reseller";
  website_domain?: string;
  social_handles?: { instagram?: string; tiktok?: string; facebook?: string };
  contact?: { name?: string; phone_e164?: string; email?: string };
  signatory?: { full_name?: string; national_id?: string; date_of_birth?: string };
  eta_registration?: "unknown" | "registered" | "not_registered";
  description_ar?: string;
  description_en?: string;
  acknowledgements?: { seller_agreement_version?: string; dpa_version?: string; price_monitoring_consent?: boolean };
}

/* ------------------------------- store settings ------------------------------- */
export const storeProfile = z.object({
  store_id: z.uuid(),
  name_ar: z.string(),
  name_en: z.string().nullish(),
  description_ar: z.string().nullish(),
  description_en: z.string().nullish(),
  logo_key: z.string().nullish(),
  cover_key: z.string().nullish(),
  social_links: z.record(z.string(), z.string()).default({}),
  return_policy: z.object({
    change_of_mind_days: z.number().int(),
    defect_days: z.number().int(),
    text_ar: z.string().nullish(),
    text_en: z.string().nullish(),
    statutory_minimum: z.object({ change_of_mind_days: z.number().int(), defect_days: z.number().int() }),
  }),
  free_delivery_threshold: money,
  vacation: z.object({ enabled: z.boolean(), until: z.string().nullable(), eta_extra_days: z.number().int() }),
  version: z.number().int(),
});
export type StoreProfile = z.infer<typeof storeProfile>;

export const mediaUpload = z.object({
  upload_id: z.uuid(),
  object_key: z.string(),
  upload_url: z.url(),
  method: z.literal("PUT"),
  headers: z.record(z.string(), z.string()).default({}),
  expires_at: z.string().nullable(),
});
export type MediaUpload = z.infer<typeof mediaUpload>;
export const mediaConfirm = z.object({
  upload_id: z.uuid(), slot: z.string(), status: z.string(), width: z.number().nullish(), height: z.number().nullish(),
});

export const payoutAccount = z.discriminatedUnion("configured", [
  z.object({ configured: z.literal(false) }),
  z.object({
    configured: z.literal(true),
    iban_masked: z.string(),
    iban_last4: z.string(),
    name_match_score: z.number(),
    payouts_held: z.boolean(),
    held_until: z.string().nullable(),
    activates_at: z.string().nullable(),
    created_at: z.string().nullable(),
  }),
]);
export type PayoutAccount = z.infer<typeof payoutAccount>;
export const payoutHistory = z.object({ items: z.array(z.object({ kind: z.string(), at: z.string().nullable(), detail: z.unknown().optional() })) });

const shippingOrigin = z.object({
  governorate_code: z.string(), city_code: z.string(), street: z.string(), building: z.string().nullish(), landmark: z.string(),
  contact_name: z.string(), contact_phone_masked: z.string(), pin: z.object({ lat: z.number(), lng: z.number() }).nullish(),
});
export const shippingProfile = z.discriminatedUnion("configured", [
  z.object({ configured: z.literal(false), handling_time_hours: z.number().int() }),
  z.object({
    configured: z.literal(true),
    origin: shippingOrigin,
    handling_time_hours: z.number().int(),
    courier_preferences: z.record(z.string(), z.array(z.string())),
    packaging_options: z.array(z.string()),
  }),
]);
export type ShippingProfile = z.infer<typeof shippingProfile>;

export const notificationPrefs = z.object({
  preferences: z.record(z.string(), z.record(z.string(), z.boolean())),
  transactional_events: z.array(z.string()),
});
export type NotificationPrefsWire = z.infer<typeof notificationPrefs>;

export const sellerTeam = z.object({
  members: z.array(z.object({ user_id: z.uuid(), role: sellerRole, phone_masked: z.string().nullable(), joined_at: z.string().nullable() })),
  invites: z.array(z.object({ id: z.uuid(), role: sellerRole, phone_masked: z.string(), status: z.string(), created_at: z.string().nullable(), expires_at: z.string().nullable() })),
});
export type SellerTeam = z.infer<typeof sellerTeam>;
export const teamInvite = z.object({ id: z.uuid(), role: sellerRole, phone_masked: z.string(), status: z.string(), expires_at: z.string().nullable() });
export const roleChange = z.object({ user_id: z.uuid(), role: sellerRole });

export const etaEnrolment = z.object({
  status: z.string(),
  failure_code: z.string().nullable(),
  requested_at: z.string().nullable(),
  last_checked_at: z.string().nullable(),
  last_verified_at: z.string().nullable(),
});
export type EtaEnrolment = z.infer<typeof etaEnrolment>;
