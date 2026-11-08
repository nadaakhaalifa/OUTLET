import { SELLER_ROLES } from "@outlet/policy";
import { describe, expect, it } from "vitest";
import { KYC_EVENTS, KYC_STATES, KycTransitionError, buyerPiiVisible, canKyc, isKycEditable, isKycOpen, isValidIban, kycGaps, nextKycState, requiredRoleFor, requiredRoleForFeature, roleCan } from "../src/index.js";
import { IBAN } from "./fixtures.js";

describe("KYC state machine", () => {
  it("follows the spec path", () => {
    expect(nextKycState("DRAFT", "submit")).toBe("SUBMITTED");
    expect(nextKycState("SUBMITTED", "start_checks")).toBe("AUTO_CHECKS");
    expect(nextKycState("AUTO_CHECKS", "approve")).toBe("APPROVED");
    expect(nextKycState("AUTO_CHECKS", "request_info")).toBe("NEEDS_INFO");
    expect(nextKycState("AUTO_CHECKS", "reject")).toBe("REJECTED");
    expect(nextKycState("NEEDS_INFO", "submit")).toBe("SUBMITTED");
    expect(nextKycState("APPROVED", "suspend")).toBe("SUSPENDED");
  });

  it("rejects every transition not in the table with a typed error", () => {
    const allowed = new Set(["DRAFT:submit", "SUBMITTED:start_checks", "AUTO_CHECKS:approve", "AUTO_CHECKS:request_info", "AUTO_CHECKS:reject", "NEEDS_INFO:submit", "NEEDS_INFO:reject", "APPROVED:suspend"]);
    for (const s of KYC_STATES) {
      for (const e of KYC_EVENTS) {
        if (allowed.has(`${s}:${e}`)) continue;
        expect(canKyc(s, e)).toBe(false);
        expect(() => nextKycState(s, e)).toThrow(KycTransitionError);
      }
    }
    expect(() => nextKycState("DRAFT", "approve")).toThrow(expect.objectContaining({ code: "invalid_transition", from: "DRAFT", event: "approve" }));
    expect(() => nextKycState("REJECTED", "submit")).toThrow(KycTransitionError);
  });

  it("never leaves a dead end except REJECTED and SUSPENDED", () => {
    for (const s of KYC_STATES) {
      const out = KYC_EVENTS.filter((e) => canKyc(s, e));
      expect(out.length === 0).toBe(s === "REJECTED" || s === "SUSPENDED");
    }
  });
});

describe("completeness and IBAN", () => {
  const full = { presentKinds: ["commercial_register", "tax_card", "signatory_national_id"] as const, thirdPartyBrands: false, hasBankAccount: true, legalIdentity: { legalNameAr: "x", commercialRegisterNo: "1", taxCardNo: "2", governorateNameAr: "g" } };
  it("lists every gap", () => {
    expect(kycGaps({ ...full, presentKinds: [...full.presentKinds] })).toEqual([]);
    expect(kycGaps({ ...full, presentKinds: ["tax_card"], hasBankAccount: false })).toEqual(["document:commercial_register", "document:signatory_national_id", "bank_account"]);
    expect(kycGaps({ ...full, presentKinds: [...full.presentKinds], thirdPartyBrands: true })).toEqual(["document:brand_authorization"]);
    expect(kycGaps({ ...full, presentKinds: [...full.presentKinds], thirdPartyBrands: true }).length).toBe(1);
    expect(kycGaps({ ...full, presentKinds: [...full.presentKinds, "proof_of_purchase"], thirdPartyBrands: true })).toEqual([]);
    expect(kycGaps({ ...full, presentKinds: [...full.presentKinds], legalIdentity: { legalNameAr: " ", commercialRegisterNo: null, taxCardNo: "2", governorateNameAr: "g" } })).toEqual(["legal_name_ar", "commercial_register_no"]);
  });
  it("validates Egyptian IBANs", () => {
    expect(isValidIban(IBAN)).toBe(true);
    expect(isValidIban(IBAN.replace(/(.{4})/gu, "$1 "))).toBe(true);
    expect(isValidIban(`${IBAN.slice(0, -1)}9`)).toBe(false);
    expect(isValidIban("EG12")).toBe(false);
    expect(isValidIban("GB82WEST12345698765432")).toBe(false);
  });
});

describe("role helpers (delegate to @outlet/policy)", () => {
  it("derives roles from the matrix, owner first", () => {
    expect(requiredRoleFor("team.manage")).toEqual(["owner"]);
    expect(requiredRoleFor("listing.write")).toEqual(["owner", "manager", "catalog"]);
    expect(requiredRoleForFeature("payouts")).toEqual(["owner", "finance"]);
    expect(requiredRoleFor("nope.nothing")).toEqual([]);
    expect(roleCan("support", "team.manage")).toBe(false);
    for (const r of SELLER_ROLES) expect(roleCan(r, "order.read") || r === "catalog").toBe(true);
  });
  it("shows buyer PII only while the order is live or until the stored seller_access_until", () => {
    const now = new Date("2030-02-01T00:00:00Z");
    expect(buyerPiiVisible({ orderState: "SHIPPED", now })).toBe(true);
    expect(buyerPiiVisible({ orderState: "CANCELLED", now })).toBe(false);
    expect(buyerPiiVisible({ orderState: "DELIVERED", sellerAccessUntil: new Date("2030-02-09T00:00:00Z"), now })).toBe(true);
    expect(buyerPiiVisible({ orderState: "CLOSED", sellerAccessUntil: new Date("2029-12-31T00:00:00Z"), now })).toBe(false);
    expect(buyerPiiVisible({ orderState: "CLOSED", sellerAccessUntil: null, now })).toBe(false);
  });
});

describe("KYC state predicates", () => {
  it("isKycEditable is true only for DRAFT and NEEDS_INFO; isKycOpen only for the ops-queue states", () => {
    expect(KYC_STATES.filter((s) => isKycEditable(s))).toEqual(["DRAFT", "NEEDS_INFO"]);
    expect(KYC_STATES.filter((s) => isKycOpen(s))).toEqual(["SUBMITTED", "AUTO_CHECKS", "NEEDS_INFO"]);
  });
});
