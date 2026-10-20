import { describe, expect, it } from "vitest";
import { GuardRejectedError, InvalidTransitionError, kycMachine } from "../state-machine";
import {
  APPLICATION_EVENTS,
  APP_ONLY_EVENTS,
  DEFAULT_CONTEXT,
  addBusinessDays,
  allowedActions,
  appealOpen,
  applicationMachine,
  applyApplicationEvent,
  evaluateCompleteness,
  getRequirements,
  matchesMagicBytes,
  normaliseBrandName,
  parseEgyptianNationalId,
  reapplyAllowed,
  resolveRequestedItems,
  validateFieldValue,
} from "./index";

const NOW = Date.UTC(2026, 9, 11);
const OK_CTX = { ...DEFAULT_CONTEXT, documentsValid: true, sanctionsClear: true, signatoryAdult21: true, requestedItemsSatisfied: true, appealOpen: true };

describe("application machine", () => {
  it("has no unreachable states", () => {
    expect(applicationMachine.analyze().unreachable).toEqual([]);
  });
  it("every non app-only edge that changes KYC state is a valid kycMachine edge", () => {
    for (const e of applicationMachine.edges()) {
      if (APP_ONLY_EVENTS.includes(e.event)) continue;
      const t = applyApplicationEvent(e.from, e.event, OK_CTX);
      if (t.kycFrom !== t.kycTo) expect(kycMachine.can(t.kycFrom, e.event as never, OK_CTX), `${e.from}-${e.event}`).toBe(true);
    }
  });
  it("approves only with a clean KYC context", () => {
    expect(() => applyApplicationEvent("IN_REVIEW", "APPROVE", DEFAULT_CONTEXT)).toThrow(GuardRejectedError);
    expect(applyApplicationEvent("IN_REVIEW", "APPROVE", OK_CTX).to).toBe("APPROVED");
  });
  it("rejects invalid transitions with typed errors", () => {
    expect(() => applyApplicationEvent("DRAFT", "APPROVE", OK_CTX)).toThrow(InvalidTransitionError);
    expect(() => applyApplicationEvent("WITHDRAWN", "SUBMIT", OK_CTX)).toThrow(InvalidTransitionError);
    expect(APPLICATION_EVENTS.length).toBe(11);
  });
  it("resubmit needs satisfied items, appeal needs an open window", () => {
    expect(() => applyApplicationEvent("NEEDS_INFO", "RESUBMIT", DEFAULT_CONTEXT)).toThrow(GuardRejectedError);
    expect(applyApplicationEvent("NEEDS_INFO", "RESUBMIT", OK_CTX).to).toBe("SUBMITTED");
    expect(() => applyApplicationEvent("REJECTED", "APPEAL", DEFAULT_CONTEXT)).toThrow(GuardRejectedError);
    expect(applyApplicationEvent("REJECTED", "APPEAL", OK_CTX).to).toBe("IN_REVIEW");
  });
});

describe("validators", () => {
  it("parses Egyptian national ids", () => {
    expect(parseEgyptianNationalId("29001010100012")).toEqual({ dob: "1990-01-01", governorateCode: "01" });
    expect(parseEgyptianNationalId("29013320100012")).toBeNull();
    expect(parseEgyptianNationalId("12")).toBeNull();
  });
  it("validates formats", () => {
    expect(validateFieldValue("tax_card_no", "123-456-789", "EG")).toBeNull();
    expect(validateFieldValue("tax_card_no", "12", "EG")).toBe("invalid_format");
    expect(validateFieldValue("domain", "localhost", "EG")).toBe("invalid_format");
    expect(validateFieldValue("domain", "brand.com", "EG")).toBeNull();
    expect(validateFieldValue("phone", "+201001234567", "EG")).toBeNull();
  });
  it("normalises brand names and checks magic bytes", () => {
    expect(normaliseBrandName("  ZARA!! ")).toBe(normaliseBrandName("zara"));
    expect(matchesMagicBytes("application/pdf", new TextEncoder().encode("%PDF-1.7"))).toBe(true);
    expect(matchesMagicBytes("image/png", new Uint8Array([1, 2, 3]))).toBe(false);
  });
});

describe("completeness and rules", () => {
  const req = getRequirements("local", "EG");
  const fields = {
    brand_name: "Zara", legal_name: "Zara Egypt LLC", ownership_basis: "brand_owner", contact_name: "Mona",
    contact_phone: "+201001234567", contact_email: "m@zara.eg", signatory_full_name: "Ali", signatory_national_id: "29001010100012",
    signatory_dob: "1990-01-01", commercial_register_no: "123456", tax_card_no: "123456789",
  };
  const doc = (code: string) => ({ requirementCode: code, uploadStatus: "uploaded" as const, scanStatus: "clean" as const, reviewStatus: "unreviewed" as const });
  const base = { country: "EG", fields, documents: [doc("commercial_register"), doc("tax_card"), doc("signatory_id"), doc("brand_authorization")], domainVerified: false, acknowledgementsAccepted: true, nowMs: NOW };
  it("is complete with one ownership proof", () => {
    expect(evaluateCompleteness(req, base)).toEqual({ complete: true, missing: [] });
  });
  it("reports missing documents, under-age signatory and unverified domain", () => {
    const r = evaluateCompleteness(req, { ...base, documents: [doc("tax_card")], fields: { ...fields, signatory_national_id: "30901010100012", signatory_dob: "2009-01-01", website_domain: "zara.eg" } });
    const kinds = r.missing.map((m) => m.kind);
    expect(kinds).toContain("document");
    expect(kinds).toContain("signatory_age");
    expect(kinds).toContain("domain_verification");
  });
  it("pending scans do not count", () => {
    const r = evaluateCompleteness(req, { ...base, documents: [{ ...doc("commercial_register"), scanStatus: "pending" }, doc("tax_card"), doc("signatory_id"), doc("brand_authorization")] });
    expect(r.missing.map((m) => m.kind)).toEqual(["document_pending_scan"]);
  });
  it("resolves requested items, cooldown, appeal and business days", () => {
    const items = resolveRequestedItems([{ code: "tax_card", kind: "document" as const, satisfied: false }, { code: "x", kind: "clarification" as const, satisfied: false }], { newDocumentCodes: new Set(["tax_card"]), changedFieldCodes: new Set(), domainVerified: false, clarifiedCodes: new Set() });
    expect(items.map((i) => i.satisfied)).toEqual([true, false]);
    expect(reapplyAllowed(NOW, NOW + 29 * 86_400_000)).toBe(false);
    expect(reapplyAllowed(NOW, NOW + 30 * 86_400_000)).toBe(true);
    expect(appealOpen("REJECTED", NOW, false, NOW + 31 * 86_400_000)).toBe(false);
    expect(appealOpen("REJECTED", NOW, true, NOW)).toBe(false);
    // Sunday 2026-10-11 + 5 business days (Fri/Sat off) = Sunday 2026-10-18 would skip Fri 16 and Sat 17 -> Thu 15 is day 4, Sun 18 day 5
    expect(new Date(addBusinessDays(Date.UTC(2026, 9, 11, 10), 5)).toISOString().slice(0, 10)).toBe("2026-10-18");
    expect(allowedActions("DRAFT", { appealOpen: false, domainVerificationNeeded: true })).toEqual(["edit", "upload_document", "submit", "withdraw", "verify_domain"]);
  });
});
