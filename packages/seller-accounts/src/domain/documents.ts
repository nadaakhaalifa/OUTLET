export const KYC_DOCUMENT_KINDS = ["commercial_register", "tax_card", "signatory_national_id", "brand_authorization", "proof_of_purchase", "iban_letter"] as const;
export type KycDocumentKind = (typeof KYC_DOCUMENT_KINDS)[number];

export interface CompletenessInput {
  /** Kinds of documents on the case that are not rejected or superseded. */
  readonly presentKinds: readonly KycDocumentKind[];
  /** The seller lists third-party brands: needs brand authorization or proof of purchase (anti-counterfeit, master prompt 19). */
  readonly thirdPartyBrands: boolean;
  readonly hasBankAccount: boolean;
  readonly legalIdentity: {
    readonly legalNameAr: string | null;
    readonly commercialRegisterNo: string | null;
    readonly taxCardNo: string | null;
    readonly governorateNameAr: string | null;
  };
}

export const REQUIRED_DOCUMENTS: readonly KycDocumentKind[] = ["commercial_register", "tax_card", "signatory_national_id"];

const blank = (v: string | null): boolean => v === null || v.trim().length === 0;

/** Every gap that blocks submission, as stable codes (UI maps them to Arabic/English copy). Empty means complete. */
export const kycGaps = (i: CompletenessInput): string[] => {
  const gaps: string[] = [];
  for (const k of REQUIRED_DOCUMENTS) if (!i.presentKinds.includes(k)) gaps.push(`document:${k}`);
  if (i.thirdPartyBrands && !i.presentKinds.includes("brand_authorization") && !i.presentKinds.includes("proof_of_purchase")) gaps.push("document:brand_authorization");
  if (!i.hasBankAccount) gaps.push("bank_account");
  if (blank(i.legalIdentity.legalNameAr)) gaps.push("legal_name_ar");
  if (blank(i.legalIdentity.commercialRegisterNo)) gaps.push("commercial_register_no");
  if (blank(i.legalIdentity.taxCardNo)) gaps.push("tax_card_no");
  if (blank(i.legalIdentity.governorateNameAr)) gaps.push("governorate_name_ar");
  return gaps;
};
