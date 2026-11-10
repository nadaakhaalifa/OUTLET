import type { KycDocumentKind } from "../domain/documents.js";

export type KycCheckType = "sanctions" | "iban_name_match" | "document_ocr";
export type KycCheckResult = "pass" | "fail" | "review";

export interface KycCheckInput {
  readonly caseId: string;
  readonly sellerId: string;
  readonly legalNameAr: string;
  readonly commercialRegisterNo: string;
  readonly taxCardNo: string;
  /** Plaintext, in memory only for this call; the adapter must not log or persist it. */
  readonly iban: string;
  readonly accountName: string;
  readonly documents: readonly { readonly id: string; readonly kind: KycDocumentKind; readonly mediaAssetId: string }[];
}

export interface KycCheckOutcome {
  readonly provider: string;
  readonly providerRef?: string;
  readonly checks: readonly { readonly type: KycCheckType; readonly result: KycCheckResult; readonly scoreBp?: number; readonly documentId?: string }[];
}

/** Sanctions/watchlist, OCR and IBAN-name matching. Production adapter stays Unconfigured (ADR-0029); a fake backs tests. */
export interface KycCheckPort {
  run(input: KycCheckInput): Promise<KycCheckOutcome>;
}

export type StrongAuthMethod = "passkey" | "totp";

/**
 * Passkey/TOTP enrolment verification (master prompt 19: mandatory for seller staff). The WebAuthn/TOTP ceremony is the
 * HTTP layer's; this port only answers "is this proof a valid enrolment for this user".
 */
export interface StrongAuthPort {
  verifyEnrollment(input: { readonly userId: string; readonly method: StrongAuthMethod; readonly proof: string }): Promise<boolean>;
}

/** Fail-closed defaults for production wiring. */
export class UnconfiguredKycCheck implements KycCheckPort {
  run(): Promise<never> {
    return Promise.reject(new Error("KYC check provider is not configured"));
  }
}
export class UnconfiguredStrongAuth implements StrongAuthPort {
  verifyEnrollment(): Promise<boolean> {
    return Promise.resolve(false);
  }
}
