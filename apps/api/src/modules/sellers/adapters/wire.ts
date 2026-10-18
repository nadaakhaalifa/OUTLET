import { sellers } from "@outlet/domain";
import type { ApplicationView } from "../application/codec";
import type { DocumentRow, DomainVerificationState, PublicDecision, RequestedItem } from "../domain/ports";

const iso = (ms: number): string => new Date(ms).toISOString();
const isoOrNull = (ms: number | null): string | null => (ms === null ? null : iso(ms));

export function documentWire(d: DocumentRow, filename: string | null) {
  return {
    id: d.id,
    requirement_code: d.requirementCode,
    ...(filename !== null ? { original_filename: filename } : {}),
    content_type: d.contentType,
    size_bytes: d.sizeBytes,
    upload_status: d.uploadStatus,
    scan_status: d.scanStatus,
    review_status: d.reviewStatus,
    review_note_public: d.reviewNotePublic,
    created_at: iso(d.createdAtMs),
  };
}

export function domainVerificationWire(d: DomainVerificationState) {
  return {
    method: d.method,
    domain: d.domain,
    status: d.status,
    ...(d.txtRecordName !== undefined ? { txt_record_name: d.txtRecordName } : {}),
    ...(d.txtRecordValue !== undefined ? { txt_record_value: d.txtRecordValue } : {}),
    ...(d.emailSentToMasked !== undefined ? { email_sent_to_masked: d.emailSentToMasked } : {}),
    ...(d.expiresAtMs !== undefined ? { expires_at: iso(d.expiresAtMs) } : {}),
    verified_at: isoOrNull(d.verifiedAtMs),
  };
}

const itemWire = (i: RequestedItem) => ({ code: i.code, kind: i.kind, message_ar: i.messageAr, message_en: i.messageEn, satisfied: i.satisfied });

function decisionWire(d: PublicDecision) {
  return {
    decision: d.decision,
    reason_code: d.reasonCode,
    message_ar: d.messageAr,
    message_en: d.messageEn,
    decided_at: iso(d.decidedAtMs),
    reapply_after: isoOrNull(d.reapplyAfterMs),
    appeal_allowed: d.appealAllowed,
  };
}

const compact = <T extends Record<string, string | null | undefined>>(o: T): Record<string, string> =>
  Object.fromEntries(Object.entries(o).filter((e): e is [string, string] => typeof e[1] === "string"));

/**
 * BrandApplication as the applicant sees it. Registration identifiers are masked to the last four characters, the
 * national id is never returned (name and last four only), internal notes and assignee never appear.
 */
export function applicationWire(v: ApplicationView, allowed: readonly sellers.ApplicationAction[]) {
  const r = v.row;
  const reg = compact({
    commercial_register_no: r.commercialRegisterNo === null ? null : sellers.maskIdentifier(r.commercialRegisterNo),
    tax_card_no: r.taxCardNo === null ? null : sellers.maskIdentifier(r.taxCardNo),
    company_reg_no: r.companyRegNo === null ? null : sellers.maskIdentifier(r.companyRegNo),
    company_reg_country: r.companyRegCountry,
    vat_or_tax_id: r.vatOrTaxId === null ? null : sellers.maskIdentifier(r.vatOrTaxId),
  });
  const trademark = compact({ register: r.trademarkRegister, number: r.trademarkNumber, owner_name: r.trademarkOwnerName });
  const contact = compact({ name: v.pii.contactName, phone_e164: v.pii.contactPhone, email: v.pii.contactEmail });
  const signatory = compact({ full_name: v.pii.signatoryFullName, national_id_last4: v.nationalId === null ? null : v.nationalId.slice(-4) });
  return {
    id: r.id,
    status: r.status,
    brand_kind: r.brandKind,
    country: r.country,
    brand_name: r.brandName,
    ...(v.pii.legalName !== undefined ? { legal_name: v.pii.legalName } : {}),
    ...(Object.keys(reg).length > 0 ? { registration: reg } : {}),
    ...(Object.keys(trademark).length > 0 ? { trademark } : {}),
    ...(r.ownershipBasis !== null ? { ownership_basis: r.ownershipBasis } : {}),
    ...(r.websiteDomain !== null ? { website_domain: r.websiteDomain } : {}),
    ...(r.domainVerification !== null ? { domain_verification: domainVerificationWire(r.domainVerification) } : {}),
    ...(Object.keys(r.socialHandles).length > 0 ? { social_handles: r.socialHandles } : {}),
    ...(Object.keys(contact).length > 0 ? { contact } : {}),
    ...(Object.keys(signatory).length > 0 ? { signatory_masked: signatory } : {}),
    ...(r.etaRegistration !== null ? { eta_registration: r.etaRegistration } : {}),
    documents: v.documents.map((d) => documentWire(d, v.filenames.get(d.id) ?? null)),
    requested_items: r.requestedItems.map(itemWire),
    decision: r.decision === null ? null : decisionWire(r.decision),
    decision_due_at: isoOrNull(r.decisionDueAtMs),
    store_id: r.storeId,
    allowed_actions: allowed,
    appeal_used: r.appealUsed,
    submitted_at: isoOrNull(r.submittedAtMs),
    created_at: iso(r.createdAtMs),
    updated_at: iso(r.updatedAtMs),
  };
}
