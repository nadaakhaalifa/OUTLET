import { describe, expect, it } from "vitest";
import { publicSellerIdentity } from "../domain/catalog-domain";
import { sellerIdentityWire } from "./wire";

describe("sellerIdentityWire (B5 allow-list)", () => {
  const rec = { legalName: " Acme LLC ", commercialRegisterNo: "CR-1", taxCardNo: "TC-1", governorate: "Cairo", approved: true };

  it("emits exactly the four fields, trimmed", () => {
    const id = publicSellerIdentity(rec);
    if (id === null) throw new Error("fixture");
    expect(sellerIdentityWire(id)).toEqual({ legal_name: "Acme LLC", commercial_register_no: "CR-1", tax_card_no: "TC-1", governorate: "Cairo" });
  });

  it("does not leak extra source fields", () => {
    const id = publicSellerIdentity({ ...rec, iban: "EG00", nationalId: "1", signatory: "x" } as typeof rec);
    if (id === null) throw new Error("fixture");
    expect(Object.keys(sellerIdentityWire(id)).sort()).toEqual(["commercial_register_no", "governorate", "legal_name", "tax_card_no"]);
    expect(JSON.stringify(sellerIdentityWire(id))).not.toMatch(/EG00|iban|national|signatory/i);
  });

  it("has no identity when unapproved or a field is blank", () => {
    expect(publicSellerIdentity({ ...rec, approved: false })).toBeNull();
    expect(publicSellerIdentity({ ...rec, taxCardNo: " " })).toBeNull();
    expect(publicSellerIdentity({ legalName: "A", commercialRegisterNo: "B", taxCardNo: "C", approved: true })).toBeNull();
  });
});
