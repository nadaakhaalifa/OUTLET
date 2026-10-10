import { DEFAULT_TAX_CATEGORIES, buildTaxDocument, money, type DocumentParty, type TaxDocument } from "../domain/bridge";
import type { StoredDocument, SubmissionRecord } from "../domain/ports";

export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const STORE_A = "00000000-0000-4000-a000-000000000001";
export const STORE_B = "00000000-0000-4000-a000-000000000002";
export const T0 = 1_800_000_000_000;

export const categories = new Map(DEFAULT_TAX_CATEGORIES.map((c) => [c.code, c]));

export const haul: DocumentParty = {
  legalNameAr: "زد أوتلت للتجارة الإلكترونية",
  legalNameEn: "Z-OUTLET",
  taxRegistrationNumber: "100-200-300",
  commercialRegister: "CR-1",
  governorate: "Cairo",
  refId: "z-outlet",
  kind: "business",
};
export const sellerParty = (storeId: string): DocumentParty => ({
  legalNameAr: "متجر الأمل",
  legalNameEn: null,
  taxRegistrationNumber: "555-666-777",
  commercialRegister: "CR-9",
  governorate: "Giza",
  refId: storeId,
  kind: "business",
});
export const consumerParty = (userId: string): DocumentParty => ({
  legalNameAr: "عميل",
  legalNameEn: null,
  taxRegistrationNumber: null,
  commercialRegister: null,
  governorate: "Cairo",
  refId: userId,
  kind: "consumer",
});

export function invoiceDoc(n: number, storeId = STORE_A, amount = 20_000n): TaxDocument {
  return buildTaxDocument({
    kind: "seller_einvoice",
    sourceRef: `settle-${n}`,
    issuedAtMs: T0 + n * 1000,
    issuer: haul,
    recipient: sellerParty(storeId),
    lines: [{ lineType: "commission", descriptionAr: "عمولة البيع", descriptionEn: "Sales commission", categoryCode: "marketplace_fee", amount: money(amount) }],
    categories,
  });
}

export function receiptDoc(n: number, userId = U(1)): TaxDocument {
  return buildTaxDocument({
    kind: "shopper_ereceipt",
    sourceRef: `og-${n}`,
    issuedAtMs: T0 + n * 1000,
    issuer: haul,
    recipient: consumerParty(userId),
    lines: [{ lineType: "delivery_fee", descriptionAr: "رسوم التوصيل", categoryCode: "shipping", amount: money(11_400n) }],
    categories,
  });
}

export const stored = (n: number, doc: TaxDocument, o: Partial<StoredDocument> = {}): StoredDocument => ({
  id: U(5000 + n),
  document: doc,
  storeId: doc.kind === "shopper_ereceipt" ? null : STORE_A,
  userId: doc.kind === "shopper_ereceipt" ? U(1) : null,
  createdAtMs: doc.issuedAtMs,
  ...o,
});

export const queued = (s: StoredDocument, o: Partial<SubmissionRecord> = {}): SubmissionRecord => ({
  documentId: s.id,
  internalId: s.document.internalId,
  state: "QUEUED",
  attempts: 0,
  maxAttempts: 3,
  nextAttemptAtMs: s.createdAtMs,
  lastSubmittedAtMs: null,
  lastError: null,
  etaUuid: null,
  signedDocumentRef: null,
  rejectionReasons: null,
  version: 0,
  createdAtMs: s.createdAtMs,
  decidedAtMs: null,
  ...o,
});
