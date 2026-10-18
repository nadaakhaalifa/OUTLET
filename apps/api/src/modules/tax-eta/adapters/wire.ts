import type { ExemptionAuditEntry, ReconciliationReport, TaxCategory, TaxDocument, VatExemption } from "../domain/bridge";
import type { DocumentWithSubmission } from "../domain/ports";

const iso = (ms: number): string => new Date(ms).toISOString();

const exemptionWire = (e: VatExemption | null) =>
  e === null
    ? null
    : {
        reason_ar: e.reasonAr,
        reason_en: e.reasonEn,
        legal_basis: e.legalBasis,
        effective_from: iso(e.effectiveFromMs),
        effective_to: e.effectiveToMs === null ? null : iso(e.effectiveToMs),
      };

export function categoryWire(c: TaxCategory) {
  return {
    code: c.code,
    name_ar: c.nameAr,
    name_en: c.nameEn,
    rate_bps: Number(c.rateBps),
    exemption: exemptionWire(c.exemption),
    version: c.version,
  };
}

export function auditWire(a: ExemptionAuditEntry) {
  return {
    category_code: a.categoryCode,
    actor_id: a.actorId,
    action: a.action,
    reason: a.reason,
    before: exemptionWire(a.before),
    after: exemptionWire(a.after),
    version_before: a.versionBefore,
    version_after: a.versionAfter,
    at: iso(a.atMs),
  };
}

const money = (m: { readonly amount: bigint; readonly currency: string }) => ({ amount: m.amount.toString(), currency: m.currency });

function documentBody(d: TaxDocument) {
  return {
    internal_id: d.internalId,
    kind: d.kind,
    source_ref: d.sourceRef,
    version: d.version,
    issued_at: iso(d.issuedAtMs),
    issuer: {
      legal_name_ar: d.issuer.legalNameAr,
      legal_name_en: d.issuer.legalNameEn,
      tax_registration_number: d.issuer.taxRegistrationNumber,
      governorate: d.issuer.governorate,
    },
    lines: d.lines.map((l) => ({
      line_type: l.lineType,
      description_ar: l.descriptionAr,
      description_en: l.descriptionEn,
      tax_category: l.taxCategoryCode,
      rate_bps: Number(l.rateBps),
      net: money(l.net),
      vat: money(l.vat),
      gross: money(l.gross),
    })),
    totals: { net: money(d.totals.net), vat: money(d.totals.vat), gross: money(d.totals.gross) },
  };
}

/** Seller view: their own invoice and ETA status. Never internal errors or other parties' identifiers. */
export function sellerInvoiceWire(v: DocumentWithSubmission) {
  const s = v.submission;
  return {
    id: v.stored.id,
    ...documentBody(v.stored.document),
    recipient: {
      legal_name_ar: v.stored.document.recipient.legalNameAr,
      tax_registration_number: v.stored.document.recipient.taxRegistrationNumber,
    },
    eta: {
      state: s.state,
      eta_uuid: s.etaUuid,
      signed_document_available: s.signedDocumentRef !== null,
      rejection_reasons: s.rejectionReasons,
    },
  };
}

export function adminDocumentWire(v: DocumentWithSubmission) {
  const s = v.submission;
  return {
    id: v.stored.id,
    ...documentBody(v.stored.document),
    store_id: v.stored.storeId,
    user_id: v.stored.userId,
    recipient: {
      ref_id: v.stored.document.recipient.refId,
      kind: v.stored.document.recipient.kind,
      legal_name_ar: v.stored.document.recipient.kind === "business" ? v.stored.document.recipient.legalNameAr : null,
    },
    submission: {
      state: s.state,
      attempts: s.attempts,
      max_attempts: s.maxAttempts,
      next_attempt_at: iso(s.nextAttemptAtMs),
      last_submitted_at: s.lastSubmittedAtMs === null ? null : iso(s.lastSubmittedAtMs),
      last_error: s.lastError,
      eta_uuid: s.etaUuid,
      signed_document_ref: s.signedDocumentRef,
      rejection_reasons: s.rejectionReasons,
      decided_at: s.decidedAtMs === null ? null : iso(s.decidedAtMs),
    },
  };
}

export function reconciliationWire(r: ReconciliationReport, authorityChecked: boolean) {
  return {
    /** False: ETA was not queried, only internal checks ran. `reconciled` then must not be shown as "reconciled". */
    authority_checked: authorityChecked,
    date: r.date,
    documents: r.documents,
    counts: r.counts,
    gross_by_state: Object.fromEntries(Object.entries(r.grossByState).map(([k, v]) => [k, v.toString()])),
    submitted: r.submitted,
    accepted: r.accepted,
    rejected: r.rejected,
    acceptance_rate_bps: r.acceptanceRateBps,
    discrepancies: r.discrepancies.map((d) => ({ internal_id: d.internalId, kind: d.kind })),
    reconciled: r.reconciled,
  };
}
