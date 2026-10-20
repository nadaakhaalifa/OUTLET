import { DomainError } from "../errors";

export const RESALE_CONDITION = "open_box_returned" as const;
export const GRADES = ["A", "B", "C"] as const;
export type Grade = (typeof GRADES)[number];

export const GRADE_LABELS: Readonly<Record<Grade, { readonly en: string; readonly ar: string }>> = {
  A: { en: "Like new", ar: "كالجديد" },
  B: { en: "Minor wear", ar: "استعمال خفيف" },
  C: { en: "Defect disclosed", ar: "عيب موضح" },
};

/** Who owns the returned unit. `platform_rtv` is hub-owned stock under return-to-vendor terms. */
export const OWNERSHIPS = ["seller", "platform_rtv"] as const;
export type Ownership = (typeof OWNERSHIPS)[number];

export const LISTING_STATUSES = ["LISTED", "SOLD", "WITHDRAWN"] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

export const RETURN_CLASSES = ["standard", "hygiene", "personalized"] as const;
export type ResaleReturnClass = (typeof RETURN_CLASSES)[number];

export class InvalidResaleInputError extends DomainError {}
export class InvalidListingTransitionError extends DomainError {
  constructor(from: ListingStatus, to: ListingStatus) {
    super(`resale listing cannot move ${from} -> ${to}`);
  }
}
