export const RETURN_REASONS = [
  "too_small",
  "too_large",
  "not_as_described",
  "defective",
  "changed_mind",
  "late",
  "wrong_item",
] as const;
export type ReturnReason = (typeof RETURN_REASONS)[number];

export const RETURN_RESOLUTIONS = ["exchange", "refund"] as const;
export type ReturnResolution = (typeof RETURN_RESOLUTIONS)[number];

export const RETURN_METHODS = ["pickup", "drop_off"] as const;
export type ReturnMethod = (typeof RETURN_METHODS)[number];

export const REFUND_PREFERENCES = ["original_method", "store_credit"] as const;
export type RefundPreference = (typeof REFUND_PREFERENCES)[number];

/** Catalog `return_class` (docs/data-model/returns.md). Hygiene and personalized are not returnable for change of mind. */
export const RETURN_CLASSES = ["standard", "hygiene", "personalized"] as const;
export type ReturnClass = (typeof RETURN_CLASSES)[number];

export const WINDOW_CLASSES = ["change_of_mind", "size_exchange", "defect"] as const;
export type WindowClass = (typeof WINDOW_CLASSES)[number];

export const SHIPPING_PAYERS = ["shopper", "seller", "platform_free"] as const;
export type ShippingPayer = (typeof SHIPPING_PAYERS)[number];

export const REJECTION_REASONS = ["used", "missing_tags", "damaged_by_customer", "wrong_item_returned", "other"] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

/** A customer-facing explanation. Arabic is authoritative (CPL 181/2018), English is the fallback. */
export interface LocalizedReason {
  readonly ar: string;
  readonly en: string;
}

export const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 86_400_000;
