import { hasArabicLetters } from "./conditions.js";

export type ActivationReason =
  | "TITLE_AR_REQUIRED"
  | "TITLE_NOT_ARABIC"
  | "DESCRIPTION_AR_REQUIRED"
  | "CATEGORY_REQUIRED"
  | "ATTRIBUTES_INCOMPLETE"
  | "NO_ACTIVE_VARIANT"
  | "VARIANT_PRICE_INVALID"
  | "GRADE_DISABLED"
  | "DEFECT_CARD_REQUIRED"
  | "DEFECT_CARD_EMPTY"
  | "DEFECT_CARD_GRADE_MISMATCH"
  | "MAIN_PHOTO_REQUIRED"
  | "CONDITION_PHOTO_REQUIRED"
  | "SELLER_LEGAL_IDENTITY_INCOMPLETE"
  | "SELLER_NOT_ACTIVE"
  | "STORE_NOT_ACTIVE";

export interface ActivationInput {
  readonly titleAr: string;
  readonly descriptionAr: string;
  readonly hasCategory: boolean;
  /** Problems from attributeIssues(set, attrs, complete = true). */
  readonly attributeIssues: readonly string[];
  readonly grade: { readonly code: string; readonly active: boolean; readonly requiresDefectCard: boolean; readonly requiresConditionPhoto: boolean };
  readonly defectCard: { readonly gradeCode: string; readonly itemCount: number } | null;
  readonly mediaRoles: readonly string[];
  readonly activeVariantPrices: readonly bigint[];
  readonly seller: {
    readonly status: string;
    readonly legalNameAr: string | null;
    readonly commercialRegisterNo: string | null;
    readonly taxCardNo: string | null;
    readonly governorateNameAr: string | null;
  };
  readonly storeStatus: string;
}

const blank = (s: string | null): boolean => s === null || s.trim().length === 0;

/** Every reason the listing cannot go live; empty means ready. Pure, ordered, no I/O. */
export const activationReasons = (i: ActivationInput): ActivationReason[] => {
  const out: ActivationReason[] = [];
  if (blank(i.titleAr)) out.push("TITLE_AR_REQUIRED");
  else if (!hasArabicLetters(i.titleAr)) out.push("TITLE_NOT_ARABIC");
  if (blank(i.descriptionAr)) out.push("DESCRIPTION_AR_REQUIRED");
  if (!i.hasCategory) out.push("CATEGORY_REQUIRED");
  if (i.attributeIssues.length > 0) out.push("ATTRIBUTES_INCOMPLETE");
  if (i.activeVariantPrices.length === 0) out.push("NO_ACTIVE_VARIANT");
  else if (i.activeVariantPrices.some((p) => p <= 0n)) out.push("VARIANT_PRICE_INVALID");
  if (!i.grade.active) out.push("GRADE_DISABLED");
  if (i.grade.requiresDefectCard) {
    if (i.defectCard === null) out.push("DEFECT_CARD_REQUIRED");
    else {
      if (i.defectCard.itemCount < 1) out.push("DEFECT_CARD_EMPTY");
      if (i.defectCard.gradeCode !== i.grade.code) out.push("DEFECT_CARD_GRADE_MISMATCH");
    }
  }
  if (!i.mediaRoles.includes("main")) out.push("MAIN_PHOTO_REQUIRED");
  if (i.grade.requiresConditionPhoto && !i.mediaRoles.includes("condition")) out.push("CONDITION_PHOTO_REQUIRED");
  const s = i.seller;
  if (s.status !== "active") out.push("SELLER_NOT_ACTIVE");
  if (blank(s.legalNameAr) || blank(s.commercialRegisterNo) || blank(s.taxCardNo) || blank(s.governorateNameAr)) out.push("SELLER_LEGAL_IDENTITY_INCOMPLETE");
  if (i.storeStatus !== "ACTIVE") out.push("STORE_NOT_ACTIVE");
  return out;
};
