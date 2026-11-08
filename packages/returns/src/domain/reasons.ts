/**
 * Return reason taxonomy (master prompt section 22, data-model 7.19). Windows count from the courier-confirmed delivered_at (B5):
 * 14 days no reason, 30 days for defective / not-as-described / wrong item (V19: confirm the 30-day period).
 */
export const RETURN_REASONS = ["too_small", "too_large", "not_as_described", "defect_undisclosed", "defect_worse_than_shown", "changed_mind", "late", "wrong_item"] as const;
export type ReturnReason = (typeof RETURN_REASONS)[number];

export type WindowBasis = "no_reason_14d" | "defect_30d";
export type Fault = "shopper" | "seller" | "courier" | "none";

export interface ReasonInfo {
  readonly windowBasis: WindowBasis;
  readonly fault: Fault;
  /** Photos are required for defective or not-as-described claims (section 22). */
  readonly photosRequired: boolean;
  readonly sizeRelated: boolean;
  /** Seller-fault / defect class: survives the non-returnable-category exclusion ("only if defective"). */
  readonly defectClass: boolean;
}

export const REASON_INFO: Readonly<Record<ReturnReason, ReasonInfo>> = {
  too_small: { windowBasis: "no_reason_14d", fault: "none", photosRequired: false, sizeRelated: true, defectClass: false },
  too_large: { windowBasis: "no_reason_14d", fault: "none", photosRequired: false, sizeRelated: true, defectClass: false },
  changed_mind: { windowBasis: "no_reason_14d", fault: "shopper", photosRequired: false, sizeRelated: false, defectClass: false },
  late: { windowBasis: "no_reason_14d", fault: "courier", photosRequired: false, sizeRelated: false, defectClass: false },
  not_as_described: { windowBasis: "defect_30d", fault: "seller", photosRequired: true, sizeRelated: false, defectClass: true },
  defect_undisclosed: { windowBasis: "defect_30d", fault: "seller", photosRequired: true, sizeRelated: false, defectClass: true },
  defect_worse_than_shown: { windowBasis: "defect_30d", fault: "seller", photosRequired: true, sizeRelated: false, defectClass: true },
  wrong_item: { windowBasis: "defect_30d", fault: "seller", photosRequired: false, sizeRelated: false, defectClass: true },
};

export const isReturnReason = (v: string): v is ReturnReason => (RETURN_REASONS as readonly string[]).includes(v);
