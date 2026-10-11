import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  InvalidListingTransitionError,
  allocateResaleProceeds,
  checkResaleEligibility,
  makesNoDiscountClaim,
  moveListing,
  resalePriceDisplay,
  validateListing,
  type ResaleCandidate,
} from "./index";

const ok: ResaleCandidate = {
  inspectionPassed: true,
  returnClass: "standard",
  priorListingsForUnit: 0,
  ownership: "seller",
  sellerOptedIn: true,
  rtvTermsAccepted: false,
};

describe("eligibility", () => {
  it("accepts an opted-in standard unit", () => expect(checkResaleEligibility(ok)).toEqual({ ok: true }));
  it("refuses in the documented order", () => {
    expect(checkResaleEligibility({ ...ok, inspectionPassed: false })).toMatchObject({ reason: "inspection_not_passed" });
    expect(checkResaleEligibility({ ...ok, returnClass: "hygiene" })).toMatchObject({ reason: "hygiene_or_personalized" });
    expect(checkResaleEligibility({ ...ok, returnClass: "personalized" })).toMatchObject({ reason: "hygiene_or_personalized" });
    expect(checkResaleEligibility({ ...ok, priorListingsForUnit: 1 })).toMatchObject({ reason: "already_resold" });
    expect(checkResaleEligibility({ ...ok, sellerOptedIn: false })).toMatchObject({ reason: "seller_declined" });
    expect(checkResaleEligibility({ ...ok, ownership: "platform_rtv", sellerOptedIn: false })).toMatchObject({ reason: "rtv_terms_missing" });
    expect(checkResaleEligibility({ ...ok, ownership: "platform_rtv", sellerOptedIn: false, rtvTermsAccepted: true })).toEqual({ ok: true });
  });
});

describe("listing validation", () => {
  it("requires photos, a defect note for C, and a positive price", () => {
    expect(validateListing({ grade: "B", photoCount: 1, defectNote: null, price: 100n })).toEqual([]);
    expect(validateListing({ grade: "B", photoCount: 0, defectNote: null, price: 100n })).toEqual(["photos_required"]);
    expect(validateListing({ grade: "C", photoCount: 1, defectNote: " ", price: 100n })).toEqual(["photos_required", "defect_note_required"]);
    expect(validateListing({ grade: "Z", photoCount: 1, defectNote: null, price: 0n })).toEqual(["grade_invalid", "price_invalid"]);
    expect(validateListing({ grade: "A", photoCount: 11, defectNote: null, price: 1n })).toEqual(["photos_too_many"]);
  });
});

describe("price display", () => {
  it("never carries a strike-through or percent off", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 9n }), fc.integer({ min: 0, max: 400 }), (price, days) => {
        const d = resalePriceDisplay(price, 0, days * 86_400_000);
        expect(makesNoDiscountClaim(d)).toBe(true);
        expect(d.label).toBe(days < 30 ? "launch_price" : "plain_price");
      }),
    );
    expect(() => resalePriceDisplay(0n, 0, 0)).toThrow();
  });
});

describe("listing machine", () => {
  it("is one way", () => {
    expect(moveListing("LISTED", "SOLD")).toBe("SOLD");
    expect(() => moveListing("SOLD", "LISTED")).toThrow(InvalidListingTransitionError);
  });
});

describe("proceeds", () => {
  it("parts sum to the gross for any terms", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        fc.integer({ min: 0, max: 10_000 }),
        fc.constantFrom("seller", "platform_rtv" as const),
        (gross, bps, ownership) => {
          const p = allocateResaleProceeds(gross, { ownership, commissionBps: bps, vendorShareBps: bps });
          expect(p.sellerPayable + p.platformRetained).toBe(gross);
          expect(p.sellerPayable >= 0n && p.platformRetained >= 0n).toBe(true);
        },
      ),
    );
  });
  it("applies commission and the vendor share", () => {
    expect(allocateResaleProceeds(10_000n, { ownership: "seller", commissionBps: 1500, vendorShareBps: 0 })).toMatchObject({ sellerPayable: 8500n, platformRetained: 1500n });
    expect(allocateResaleProceeds(10_000n, { ownership: "platform_rtv", commissionBps: 1500, vendorShareBps: 3000 })).toMatchObject({ sellerPayable: 3000n, platformRetained: 7000n });
    expect(() => allocateResaleProceeds(1n, { ownership: "seller", commissionBps: 10_001, vendorShareBps: 0 })).toThrow();
  });
});
