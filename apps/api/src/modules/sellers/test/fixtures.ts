import type { ApplicationRow, DocumentRow, HistoryDraft } from "../domain/ports";

export const T0 = Date.UTC(2026, 9, 11, 9, 0, 0);
export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const APPLICANT_A = U(1);
export const APPLICANT_B = U(2);
export const ADMIN = U(900);

export class TestClock {
  constructor(public ms: number = T0) {}
  nowMs(): number {
    return this.ms;
  }
  advance(deltaMs: number): void {
    this.ms += deltaMs;
  }
}

export const appRow = (n: number, over: Partial<ApplicationRow> = {}): ApplicationRow => ({
  id: U(100 + n), applicantId: APPLICANT_A, status: "DRAFT", version: 0, brandKind: "local", country: "EG", brandName: `Brand ${n}`,
  brandNameNorm: `brand ${n}`, ownershipBasis: null, trademarkRegister: null, trademarkNumber: null, trademarkOwnerName: null,
  commercialRegisterNo: null, taxCardNo: null, companyRegNo: null, companyRegCountry: null, vatOrTaxId: null, websiteDomain: null,
  socialHandles: {}, etaRegistration: null, descriptionAr: null, descriptionEn: null, acknowledgements: {}, piiEnc: null,
  nationalIdEnc: null, nationalIdBlind: null, domainVerification: null, appealUsed: false, appealStatement: null, submittedAtMs: null,
  decision: null, decisionDueAtMs: null, rejectedAtMs: null, storeId: null, assigneeId: null, claimedAtMs: null, requestedItems: [],
  requestedAtMs: null, createdAtMs: T0 + n * 1000, updatedAtMs: T0 + n * 1000, ...over,
});

export const docRow = (appId: string, applicantId: string, n: number, over: Partial<DocumentRow> = {}): DocumentRow => ({
  id: U(500 + n), applicationId: appId, applicantId, requirementCode: "commercial_register", originalFilenameEnc: null,
  contentType: "application/pdf", sizeBytes: 1000, sha256: "a".repeat(64), objectKey: `kyc/2026/10/${U(500 + n)}`,
  uploadStatus: "awaiting_upload", scanStatus: "pending", reviewStatus: "unreviewed", reviewNotePublic: null, reviewNoteInternal: null,
  createdAtMs: T0 + n, uploadedAtMs: null, ...over,
});

export const hist = (n: number, from: HistoryDraft["fromStatus"], to: HistoryDraft["toStatus"]): HistoryDraft => ({
  id: U(700 + n), fromStatus: from, toStatus: to, event: "TEST", actorType: "APPLICANT", actorId: APPLICANT_A, reasonCode: null, occurredAtMs: T0 + n,
});
