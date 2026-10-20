import { describe, expect, it } from "vitest";
import { money } from "../money";
import { buildSellerGoodsReceipt, buildTaxDocument, internalIdFor, type DocumentParty } from "./documents";
import { DEFAULT_TAX_CATEGORIES } from "./exemptions";

const categories = new Map(DEFAULT_TAX_CATEGORIES.map((c) => [c.code, c]));
const haul: DocumentParty = { legalNameAr: "زد أوتلت للتجارة", legalNameEn: "Z-OUTLET", taxRegistrationNumber: "100-200-300", commercialRegister: "CR1", governorate: "Cairo", refId: "haul", kind: "business" };
const seller: DocumentParty = { legalNameAr: "متجر الأمل", legalNameEn: null, taxRegistrationNumber: "555-666-777", commercialRegister: "CR9", governorate: "Giza", refId: "store-1", kind: "business" };
const shopper: DocumentParty = { legalNameAr: "عميل", legalNameEn: null, taxRegistrationNumber: null, commercialRegister: null, governorate: "Cairo", refId: "user-1", kind: "consumer" };
const base = { issuedAtMs: 1_800_000_000_000, categories };

describe("tax documents", () => {
  it("builds a seller e-invoice adding 14% VAT to net commission", () => {
    const d = buildTaxDocument({
      ...base,
      kind: "seller_einvoice",
      sourceRef: "settle-2026-10-w1:store-1",
      issuer: haul,
      recipient: seller,
      lines: [
        { lineType: "commission", descriptionAr: "عمولة البيع", categoryCode: "marketplace_fee", amount: money(20_000n) },
        { lineType: "ads", descriptionAr: "إعلانات", descriptionEn: "Ads", categoryCode: "marketplace_fee", amount: money(5_000n) },
      ],
    });
    expect(d.totals.net.amount).toBe(25_000n);
    expect(d.totals.vat.amount).toBe(3_500n);
    expect(d.totals.gross.amount).toBe(28_500n);
    expect(d.internalId).toBe("INV-settle-2026-10-w1:store-1-v1");
  });
  it("builds a shopper e-receipt from VAT inclusive amounts", () => {
    const d = buildTaxDocument({
      ...base,
      kind: "shopper_ereceipt",
      sourceRef: "og-1",
      issuer: haul,
      recipient: shopper,
      lines: [{ lineType: "delivery_fee", descriptionAr: "رسوم التوصيل", categoryCode: "shipping", amount: money(11_400n) }],
    });
    expect([d.totals.net.amount, d.totals.vat.amount, d.totals.gross.amount]).toEqual([10_000n, 1_400n, 11_400n]);
  });
  it("is deterministic for idempotent re-issue and versions corrections", () => {
    expect(internalIdFor("shopper_ereceipt", "og-1")).toBe(internalIdFor("shopper_ereceipt", "og-1", 1));
    expect(internalIdFor("shopper_ereceipt", "og-1", 2)).not.toBe(internalIdFor("shopper_ereceipt", "og-1"));
  });
  it("requires Arabic text, valid line types, matching recipient kind and tax ids", () => {
    const mk = (o: Record<string, unknown>) =>
      buildTaxDocument({
        ...base,
        kind: "shopper_ereceipt",
        sourceRef: "og-2",
        issuer: haul,
        recipient: shopper,
        lines: [{ lineType: "delivery_fee", descriptionAr: "رسوم", categoryCode: "shipping", amount: money(100n) }],
        ...o,
      });
    expect(() => mk({ lines: [{ lineType: "delivery_fee", descriptionAr: "Delivery", categoryCode: "shipping", amount: money(100n) }] })).toThrow(/Arabic/);
    expect(() => mk({ lines: [{ lineType: "commission", descriptionAr: "رسوم", categoryCode: "shipping", amount: money(100n) }] })).toThrow(/not allowed/);
    expect(() => mk({ recipient: seller })).toThrow(/consumer/);
    expect(() => mk({ issuer: { ...haul, legalNameAr: "Z-OUTLET" } })).toThrow(/Arabic/);
    expect(() => mk({ issuer: { ...haul, taxRegistrationNumber: null } })).toThrow(/tax registration/);
    expect(() => mk({ sourceRef: "bad ref" })).toThrow();
    expect(() => mk({ lines: [] })).toThrow();
  });
  it("seller goods receipt needs an active delegation for that seller", () => {
    const input = {
      ...base,
      sourceRef: "so-1",
      issuer: seller,
      recipient: shopper,
      lines: [{ lineType: "goods", descriptionAr: "فستان", categoryCode: "standard", amount: money(114_00n) }],
    };
    expect(() => buildSellerGoodsReceipt(input, null)).toThrow(/delegated/);
    expect(() => buildSellerGoodsReceipt(input, { sellerId: "store-1", active: false, signingRef: "x" })).toThrow();
    expect(() => buildSellerGoodsReceipt(input, { sellerId: "store-2", active: true, signingRef: "x" })).toThrow();
    const d = buildSellerGoodsReceipt(input, { sellerId: "store-1", active: true, signingRef: "tok" });
    expect(d.kind).toBe("seller_goods_ereceipt");
    expect(d.totals.vat.amount).toBe(1_400n);
  });
});
