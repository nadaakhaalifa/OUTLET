import {
  GRADES,
  InvalidListingTransitionError,
  InvalidResaleInputError,
  type Grade,
  type ListingStatus,
  type Ownership,
  type ResaleReturnClass,
} from "./types";
import { allocate, money } from "../money";

// ---- eligibility ----

export type ResaleRefusal =
  | "inspection_not_passed"
  | "hygiene_or_personalized"
  | "already_resold"
  | "seller_declined"
  | "rtv_terms_missing";

export interface ResaleCandidate {
  readonly inspectionPassed: boolean;
  readonly returnClass: ResaleReturnClass;
  /** Listings ever created for this physical unit (a unit loops once only). */
  readonly priorListingsForUnit: number;
  readonly ownership: Ownership;
  /** Seller explicitly opted in (ownership `seller`). */
  readonly sellerOptedIn: boolean;
  /** A signed return-to-vendor term covers the unit (ownership `platform_rtv`). */
  readonly rtvTermsAccepted: boolean;
}

export type ResaleEligibility = { readonly ok: true } | { readonly ok: false; readonly reason: ResaleRefusal };

export function checkResaleEligibility(c: ResaleCandidate): ResaleEligibility {
  if (!c.inspectionPassed) return { ok: false, reason: "inspection_not_passed" };
  if (c.returnClass !== "standard") return { ok: false, reason: "hygiene_or_personalized" };
  if (c.priorListingsForUnit >= 1) return { ok: false, reason: "already_resold" };
  if (c.ownership === "seller" && !c.sellerOptedIn) return { ok: false, reason: "seller_declined" };
  if (c.ownership === "platform_rtv" && !c.rtvTermsAccepted) return { ok: false, reason: "rtv_terms_missing" };
  return { ok: true };
}

// ---- listing validation ----

export const RESALE_LIMITS = { photosMax: 10, defectNoteMax: 500, photosMinA: 1, photosMinB: 1, photosMinC: 2 } as const;

export interface ListingDraft {
  readonly grade: string;
  readonly photoCount: number;
  readonly defectNote: string | null;
  /** Piastres. */
  readonly price: bigint;
}

export type ListingIssue = "grade_invalid" | "photos_required" | "photos_too_many" | "defect_note_required" | "price_invalid";

export function validateListing(d: ListingDraft): readonly ListingIssue[] {
  const issues: ListingIssue[] = [];
  if (!(GRADES as readonly string[]).includes(d.grade)) {
    issues.push("grade_invalid");
  } else {
    const min = d.grade === "C" ? RESALE_LIMITS.photosMinC : d.grade === "B" ? RESALE_LIMITS.photosMinB : RESALE_LIMITS.photosMinA;
    if (d.photoCount < min) issues.push("photos_required");
    if (d.grade === "C" && (d.defectNote === null || d.defectNote.trim() === "")) issues.push("defect_note_required");
  }
  if (d.photoCount > RESALE_LIMITS.photosMax) issues.push("photos_too_many");
  if (d.price <= 0n) issues.push("price_invalid");
  return issues;
}

// ---- price display: never a % off against the original VRP ----

export const LAUNCH_PRICE_DAYS = 30;
const MS_PER_DAY = 86_400_000;

export interface ResalePriceDisplay {
  readonly price: bigint;
  /** `launch_price` while the listing is under 30 days old (spec 9.3), else a plain price. */
  readonly label: "launch_price" | "plain_price";
  readonly strikeThroughPrice: null;
  readonly percentOff: null;
}

export function resalePriceDisplay(price: bigint, listedAtMs: number, nowMs: number): ResalePriceDisplay {
  if (price <= 0n) throw new InvalidResaleInputError("price must be positive");
  const young = nowMs - listedAtMs < LAUNCH_PRICE_DAYS * MS_PER_DAY;
  return { price, label: young ? "launch_price" : "plain_price", strikeThroughPrice: null, percentOff: null };
}

/** True only for a display that makes no reference-price claim at all. */
export const makesNoDiscountClaim = (d: { readonly strikeThroughPrice: unknown; readonly percentOff: unknown }): boolean =>
  d.strikeThroughPrice === null && d.percentOff === null;

// ---- listing state machine ----

const LISTING_NEXT: Readonly<Record<ListingStatus, readonly ListingStatus[]>> = {
  LISTED: ["SOLD", "WITHDRAWN"],
  SOLD: [],
  WITHDRAWN: [],
};

export function moveListing(from: ListingStatus, to: ListingStatus): ListingStatus {
  if (!LISTING_NEXT[from].includes(to)) throw new InvalidListingTransitionError(from, to);
  return to;
}

// ---- proceeds ----

export interface ProceedsTerms {
  readonly ownership: Ownership;
  /** `seller`: platform commission, basis points of gross. */
  readonly commissionBps: number;
  /** `platform_rtv`: the vendor's share of gross under the return-to-vendor terms. */
  readonly vendorShareBps: number;
}

export interface Proceeds {
  readonly gross: bigint;
  /** Owed to the seller (a payable, released by the payouts module after CLOSED). */
  readonly sellerPayable: bigint;
  /** Kept by the platform: commission (seller-owned) or retained margin (hub-owned). */
  readonly platformRetained: bigint;
}

/**
 * Splits a resale's gross (VAT inclusive; the tax module extracts VAT) into two integer parts that
 * sum to the gross.
 * Options: (a) round each part with banker's rounding (can drift by 1 piastre), (b) largest
 * remainder on the gross (chosen: exact sum, no new rounding point beyond money.allocate).
 */
export function allocateResaleProceeds(gross: bigint, t: ProceedsTerms): Proceeds {
  if (gross < 0n) throw new InvalidResaleInputError("gross must not be negative");
  const platformBps = t.ownership === "seller" ? t.commissionBps : 10_000 - t.vendorShareBps;
  const sellerBps = 10_000 - platformBps;
  for (const b of [platformBps, sellerBps]) {
    if (!Number.isInteger(b) || b < 0 || b > 10_000) throw new InvalidResaleInputError("basis points out of range");
  }
  if (gross === 0n) return { gross, sellerPayable: 0n, platformRetained: 0n };
  const [seller, platform] = allocate(money(gross), [BigInt(sellerBps), BigInt(platformBps)]);
  return { gross, sellerPayable: seller?.amount ?? 0n, platformRetained: platform?.amount ?? 0n };
}

export const isGrade = (v: string): v is Grade => (GRADES as readonly string[]).includes(v);
