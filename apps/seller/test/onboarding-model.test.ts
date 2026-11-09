import { describe, expect, it } from "vitest";
import { createTranslator } from "@outlet/i18n";
import { DOC_TYPES, EMPTY_IDENTITY, GOVERNORATES, KYC_STATES, STATE_KEYS, docKey, documentPresent, editable, gapKey, governorateKey, ibanValid, identityProblems, normalizeIban, validDocumentFile } from "../src/lib/onboarding-model";

const ar = createTranslator("ar-EG");
const en = createTranslator("en-EG");

describe("identityProblems", () => {
  it("lists every missing field and passes a complete form", () => {
    expect(identityProblems(EMPTY_IDENTITY)).toEqual(["nameAr", "register", "tax", "governorate", "signatory"]);
    expect(identityProblems({ ...EMPTY_IDENTITY, nameAr: " شركة ", register: "1", tax: "2", governorate: "cairo", signatoryOk: true })).toEqual([]);
    expect(identityProblems({ ...EMPTY_IDENTITY, nameAr: "   ", register: "1", tax: "2", governorate: "cairo", signatoryOk: true })).toEqual(["nameAr"]);
  });
});

describe("ibanValid", () => {
  it("accepts a real Egyptian IBAN with spaces and lowercase, and rejects bad checksum, shape and length", () => {
    expect(ibanValid("EG380019000500000000263180002")).toBe(true);
    expect(ibanValid("eg38 0019 0005 0000 0000 2631 8000 2")).toBe(true);
    expect(ibanValid("GB82WEST12345698765432")).toBe(true);
    expect(ibanValid("EG380019000500000000263180003")).toBe(false);
    expect(ibanValid("12345")).toBe(false);
    expect(ibanValid("")).toBe(false);
    expect(normalizeIban(" eg38 0019 ")).toBe("EG380019");
  });
});

describe("validDocumentFile", () => {
  it("allows a non-empty PDF within 10 MB only", () => {
    expect(validDocumentFile({ type: "application/pdf", size: 10 })).toBeNull();
    expect(validDocumentFile({ type: "image/png", size: 10 })).toBe("type");
    expect(validDocumentFile({ type: "application/pdf", size: 0 })).toBe("size");
    expect(validDocumentFile({ type: "application/pdf", size: 10 * 1024 * 1024 + 1 })).toBe("size");
  });
});

describe("gaps and states", () => {
  it("maps API gap codes to copy keys, naming the document where there is one", () => {
    expect(gapKey("document:tax_card")).toEqual({ key: "seller.kyc.gap.document", doc: "tax_card" });
    expect(gapKey("document:nope")).toEqual({ key: "seller.kyc.gap.unknown" });
    expect(gapKey("bank_account").key).toBe("seller.kyc.gap.bank_account");
    expect(gapKey("whatever").key).toBe("seller.kyc.gap.unknown");
    expect(documentPresent(["document:tax_card"], "tax_card")).toBe(false);
    expect(documentPresent(["bank_account"], "tax_card")).toBe(true);
  });
  it("only DRAFT and NEEDS_INFO accept edits", () => {
    expect(KYC_STATES.filter(editable)).toEqual(["DRAFT", "NEEDS_INFO"]);
  });
  it("has Arabic and English copy for every state, document and governorate", () => {
    for (const s of KYC_STATES) for (const k of [STATE_KEYS[s].label, STATE_KEYS[s].desc]) for (const t of [ar, en]) expect(t(k)).not.toBe(k);
    for (const d of DOC_TYPES) for (const t of [ar, en]) expect(t(docKey(d))).not.toBe(docKey(d));
    for (const g of GOVERNORATES) for (const t of [ar, en]) expect(t(governorateKey(g))).not.toBe(governorateKey(g));
    expect(GOVERNORATES).toHaveLength(27);
  });
});
