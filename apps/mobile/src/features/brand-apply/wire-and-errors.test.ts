import { describe, expect, it } from "vitest";
import { ApiError, ContractDriftError, NetworkError, TimeoutError, type schemas } from "../../services/api-client";
import { BrandApplyError } from "./model";
import { fromWireValues, isSendable, toWirePatch } from "./wire-map";
import { mapApplication, mapDocument, mapDomain, mapRequirements, toBrandError } from "./api";

describe("wire-map", () => {
  it("only mapped field codes are sendable", () => {
    expect(isSendable("legal_name")).toBe(true);
    expect(isSendable("contact_phone")).toBe(true);
    expect(isSendable("not_a_field")).toBe(false);
  });

  it("nests grouped codes and keeps top-level codes flat", () => {
    const wire = toWirePatch({
      brandName: "Nile", ownershipBasis: "owner",
      values: { legal_name: "Nile LLC", tax_card_no: "123", instagram: "nile", contact_phone: "+201000000000", signatory_full_name: "A B" },
    });
    expect(wire).toEqual({
      brand_name: "Nile", ownership_basis: "owner", legal_name: "Nile LLC",
      registration: { tax_card_no: "123" }, social_handles: { instagram: "nile" },
      contact: { phone_e164: "+201000000000" }, signatory: { full_name: "A B" },
    });
  });

  it("drops empty values and unknown codes instead of sending them", () => {
    expect(toWirePatch({ values: { legal_name: "", mystery: "x", tiktok: "" } })).toEqual({});
    expect(toWirePatch({})).toEqual({});
  });

  it("merges several keys of one group into one object", () => {
    const wire = toWirePatch({ values: { commercial_register_no: "1", tax_card_no: "2" } });
    expect(wire).toEqual({ registration: { commercial_register_no: "1", tax_card_no: "2" } });
  });

  it("reads flat values back, using the masked signatory and ignoring blanks", () => {
    const flat = fromWireValues({
      legal_name: "Nile LLC", website_domain: "",
      registration: { tax_card_no: "123", commercial_register_no: 5 },
      contact: { email: "a@b.eg" },
      signatory_masked: { full_name: "A B", national_id: "************12" },
      signatory: { full_name: "SHOULD NOT BE READ" },
    });
    expect(flat["legal_name"]).toBe("Nile LLC");
    expect(flat["tax_card_no"]).toBe("123");
    expect(flat["commercial_register_no"]).toBeUndefined();
    expect(flat["website_domain"]).toBeUndefined();
    expect(flat["contact_email"]).toBe("a@b.eg");
    expect(flat["signatory_full_name"]).toBe("A B");
  });

  it("tolerates a non-object group", () => {
    expect(fromWireValues({ registration: "oops", contact: [] })).toEqual({});
  });
});

describe("toBrandError", () => {
  const api = (status: number, code?: string) => new ApiError("op", status, (code === undefined ? { title: "t", status } : { title: "t", status, code }) as ConstructorParameters<typeof ApiError>[2], true, null);
  it("passes a BrandApplyError through unchanged", () => {
    const e = new BrandApplyError("conflict");
    expect(toBrandError(e)).toBe(e);
  });
  it("maps transport failures to offline", () => {
    expect(toBrandError(new NetworkError("op", new Error("down"))).code).toBe("offline");
    expect(toBrandError(new TimeoutError("op", 1000)).code).toBe("offline");
  });
  it("maps contract drift to failed with a detail", () => {
    const e = toBrandError(new ContractDriftError("op", "response", [], 200));
    expect(e.code).toBe("failed");
    expect(e.detail).toBe("contract_drift");
  });
  it("maps unknown errors to failed", () => {
    expect(toBrandError(new Error("boom")).code).toBe("failed");
    expect(toBrandError("string").code).toBe("failed");
  });
  it("maps problem codes and HTTP statuses", () => {
    expect(toBrandError(api(409, "reapply_cooldown")).code).toBe("reapply_cooldown");
    expect(toBrandError(api(400, "strong_factor_required")).code).toBe("strong_factor_required");
    expect(toBrandError(api(401)).code).toBe("session_expired");
    expect(toBrandError(api(404)).code).toBe("not_found");
    expect(toBrandError(api(409)).code).toBe("conflict");
    expect(toBrandError(api(429)).code).toBe("rate_limited");
    expect(toBrandError(api(422)).code).toBe("invalid_code");
    expect(toBrandError(api(400)).code).toBe("invalid_code");
    expect(toBrandError(api(500)).code).toBe("failed");
  });
});

describe("wire to view mappers", () => {
  it("mapRequirements defaults the size cap, unknown file types and bilingual help", () => {
    const r = mapRequirements({
      kind: "local", country: "EG", version: 3, website_verification: "optional",
      fields: [{ code: "legal_name", label_ar: "ا", label_en: "Legal", required: true, format: "text" }],
      documents: [
        { code: "tax_card", label_ar: "ب", label_en: "Tax", required: true, accepts: ["pdf", "gif"], one_of_group: "g", help_en: "only en" },
        { code: "x", label_ar: "ج", label_en: "X", required: false, accepts: ["png"], max_bytes: 5, help_ar: "ar" },
      ],
    } as unknown as schemas.BrandRequirements);
    expect(r.version).toBe(3);
    expect(r.documents[0]?.accepts).toEqual(["pdf", "pdf"]);
    expect(r.documents[0]?.maxBytes).toBe(10 * 1024 * 1024);
    expect(r.documents[0]?.help).toEqual({ ar: "only en", en: "only en" });
    expect(r.documents[1]?.maxBytes).toBe(5);
    expect(r.documents[1]?.help).toEqual({ ar: "ar", en: "ar" });
    expect(r.documents[1]?.group).toBeUndefined();
  });

  it("mapDocument and mapDomain rename wire keys", () => {
    const d = mapDocument({ id: "1", requirement_code: "c", content_type: "application/pdf", size_bytes: 9, upload_status: "uploaded", scan_status: "clean", review_status: "rejected", review_note_public: null } as unknown as schemas.BrandDocument);
    expect(d).toMatchObject({ id: "1", requirementCode: "c", sizeBytes: 9, reviewStatus: "rejected", reviewNote: undefined });
    const m = mapDomain({ method: "dns_txt", domain: "a.eg", status: "pending", txt_record_name: "n", txt_record_value: "v", email_sent_to_masked: "a***@a.eg", expires_at: "2026-01-01" } as unknown as schemas.DomainVerification);
    expect(m).toMatchObject({ txtName: "n", txtValue: "v", emailMasked: "a***@a.eg", expiresAt: "2026-01-01" });
  });

  const base = {
    id: "app1", status: "NEEDS_INFO", brand_kind: "local", country: "EG", brand_name: "Nile", legal_name: "Nile LLC",
    documents: [], requested_items: [{ code: "r", kind: "field", message_ar: "ا", message_en: "e" }], allowed_actions: ["edit"],
  };
  it("mapApplication fills safe defaults for optional wire fields", () => {
    const v = mapApplication(base as unknown as schemas.BrandApplication, "etag-1");
    expect(v).toMatchObject({ id: "app1", status: "NEEDS_INFO", kind: "local", brandName: "Nile", decision: null, domain: null, decisionDueAt: null, submittedAt: null, storeId: null, appealUsed: false, version: "etag-1" });
    expect(v.requestedItems[0]?.satisfied).toBe(false);
    expect(v.values["legal_name"]).toBe("Nile LLC");
  });
  it("mapApplication reports a failed provisioning as APPROVED and maps the decision", () => {
    const v = mapApplication({
      ...base, status: "PROVISIONING_FAILED", store_id: "s1",
      decision: { decision: "rejected", reason_code: "other", message_ar: "ا", message_en: "e", decided_at: "2026-01-01", appeal_allowed: true },
      domain_verification: { method: "email", domain: "a.eg", status: "verified" },
    } as unknown as schemas.BrandApplication, null);
    expect(v.status).toBe("APPROVED");
    expect(v.storeId).toBe("s1");
    expect(v.decision).toMatchObject({ reasonCode: "other", appealAllowed: true, reapplyAfter: null });
    expect(v.domain?.status).toBe("verified");
  });
});
