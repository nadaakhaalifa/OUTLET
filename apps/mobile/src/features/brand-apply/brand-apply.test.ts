import { describe, expect, it } from "vitest";
import { countryList, flagEmoji, foldSearch } from "./countries";
import { InMemoryBrandApplyPort, fakeRequirements } from "./fake";
import {
  buildChecklist, canStartUpload, dirtyValues, expectedTime, normalizeDomain, normalizePhone, parseDraft, rejectionView, resubmitReady, resumeTarget,
  slotFromServer, slotReducer, stepsFor, submitBlockers, timeline, validateAccount, validateDetails, validateFile,
  type DocView, type SlotState, type ApplicationView,
} from "./model";
import { sha256Hex } from "./sha256";

const doc = (p: Partial<DocView>): DocView => ({ id: "d", requirementCode: "tax_card", contentType: "application/pdf", sizeBytes: 10, uploadStatus: "uploaded", scanStatus: "clean", reviewStatus: "unreviewed", ...p });

describe("sha256", () => {
  it("matches known vectors", () => {
    expect(sha256Hex(new Uint8Array())).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("countries", () => {
  it("pins Egypt first and restricts local brands", () => {
    expect(countryList({ kind: "global", query: "" })[0]?.code).toBe("EG");
    expect(countryList({ kind: "local", query: "" }).map((c) => c.code)).toEqual(["EG"]);
  });
  it("searches Arabic and English with folding", () => {
    expect(countryList({ kind: "global", query: "مِصر" }).map((c) => c.code)).toContain("EG");
    expect(countryList({ kind: "global", query: "germ" }).map((c) => c.code)).toEqual(["DE"]);
    expect(foldSearch("الإمارات")).toBe(foldSearch("الامارات"));
    expect(flagEmoji("EG")).toBe("🇪🇬");
  });
});

describe("account validation", () => {
  it("normalises Egyptian numbers and flags bad input", () => {
    expect(normalizePhone("0100 123 4567")).toBe("+201001234567");
    expect(normalizePhone("٠١٠٠١٢٣٤٥٦٧")).toBe("+201001234567");
    expect(validateAccount({ brandName: "Nile", phone: "01001234567", email: "a@b.co" })).toEqual({});
    const e = validateAccount({ brandName: "N", phone: "123", email: "x" });
    expect(e).toEqual({ brandName: "too_short", phone: "invalid_phone", email: "invalid_email" });
  });
});

describe("details validation (requirements as data)", () => {
  const req = fakeRequirements("local", "EG");
  it("requires registration numbers and a 21+ signatory", () => {
    const e = validateDetails(req.fields, { legal_name: "Nile Atelier LLC", commercial_register_no: "12", tax_card_no: "abc", signatory_national_id: "123", signatory_date_of_birth: "2020-01-01" });
    expect(e["commercial_register_no"]).toBe("invalid_format");
    expect(e["tax_card_no"]).toBe("invalid_format");
    expect(e["signatory_national_id"]).toBe("invalid_format");
    expect(e["signatory_date_of_birth"]).toBe("signatory_too_young");
    expect(e["contact_email"]).toBe("required");
    expect(e["website_domain"]).toBeUndefined();
  });
  it("accepts a complete form and rejects free-mail domains", () => {
    const ok = { legal_name: "Nile Atelier LLC", commercial_register_no: "123456", tax_card_no: "123-456-789", signatory_full_name: "Omar Said", signatory_national_id: "29001011234567", signatory_date_of_birth: "1990-01-01", contact_name: "Omar", contact_email: "o@nile.com" };
    expect(validateDetails(req.fields, ok)).toEqual({});
    expect(validateDetails(req.fields, { ...ok, website_domain: "gmail.com" })["website_domain"]).toBe("domain_not_allowed");
    expect(normalizeDomain("https://www.Nile.com/shop")).toBe("nile.com");
  });
  it("tracks only changed values for autosave", () => {
    expect(dirtyValues({ a: "1", b: "2" }, { a: "1", b: "3", c: "x" })).toEqual({ b: "3", c: "x" });
  });
});

describe("file validation", () => {
  it("checks type, size, emptiness", () => {
    const acc = ["pdf", "jpg", "png"] as const;
    expect(validateFile({ mimeType: "application/pdf", sizeBytes: 100 }, acc)).toBeNull();
    expect(validateFile({ mimeType: "application/x-msdownload", sizeBytes: 100 }, acc)).toBe("type");
    expect(validateFile({ mimeType: "image/png", sizeBytes: 10 * 1024 * 1024 + 1 }, acc)).toBe("size");
    expect(validateFile({ mimeType: "image/png", sizeBytes: 0 }, acc)).toBe("empty");
  });
});

describe("document slot state machine", () => {
  const run = (evs: Parameters<typeof slotReducer>[1][], from: SlotState = { kind: "missing" }) => evs.reduce(slotReducer, from);
  it("walks upload -> uploaded and never goes backwards on progress", () => {
    expect(run([{ t: "start" }, { t: "progress", ratio: 0.6 }, { t: "progress", ratio: 0.2 }])).toEqual({ kind: "uploading", progress: 0.6 });
    expect(run([{ t: "start" }, { t: "done" }])).toEqual({ kind: "uploaded" });
  });
  it("fails retryably on network and ignores a second start while uploading", () => {
    expect(run([{ t: "start" }, { t: "fail", reason: "network" }])).toEqual({ kind: "failed", reason: "network", retryable: true });
    expect(run([{ t: "start" }, { t: "fail", reason: "size" }])).toEqual({ kind: "failed", reason: "size", retryable: false });
    expect(canStartUpload({ kind: "uploading", progress: 0 })).toBe(false);
    expect(canStartUpload({ kind: "scanning" })).toBe(false);
  });
  it("maps server docs", () => {
    expect(slotFromServer(doc({ scanStatus: "pending" })).kind).toBe("scanning");
    expect(slotFromServer(doc({ scanStatus: "infected" }))).toEqual({ kind: "rejected", reason: "infected" });
    expect(slotFromServer(doc({ reviewStatus: "accepted" })).kind).toBe("accepted");
    expect(slotFromServer(doc({ uploadStatus: "expired" })).kind).toBe("needs_replacement");
    expect(slotFromServer(doc({ reviewStatus: "unreadable" })).kind).toBe("rejected");
  });
  it("builds the checklist with one-of groups", () => {
    const docs = fakeRequirements("local", "EG").documents;
    const slots: Record<string, SlotState> = { commercial_register: { kind: "accepted" }, tax_card: { kind: "uploaded" }, signatory_id: { kind: "scanning" } };
    expect(buildChecklist(docs, slots).missing).toEqual(["ownership"]);
    const done = buildChecklist(docs, { ...slots, brand_authorization: { kind: "uploaded" } });
    expect(done.complete).toBe(true);
    expect(buildChecklist(docs, { ...slots, trademark_certificate: { kind: "rejected", reason: "rejected" } }).complete).toBe(false);
  });
});

describe("resumability", () => {
  const base = { draftId: "abcdefgh1", kind: "local" as const, country: "EG", brandName: "Nile", step: "documents" as const };
  it("parses persisted drafts safely", () => {
    expect(parseDraft("{bad")).toMatchObject({ draftId: null, step: "type" });
    expect(parseDraft(JSON.stringify(base)).step).toBe("documents");
  });
  it("resumes at the saved step, status once submitted, and clamps impossible steps", () => {
    expect(resumeTarget(base, { status: "DRAFT" }, true)).toEqual({ route: "step", step: "documents" });
    expect(resumeTarget(base, { status: "IN_REVIEW" }, true)).toEqual({ route: "status" });
    expect(resumeTarget({ ...base, draftId: null, kind: null, country: null, step: "review" }, null, false)).toEqual({ route: "step", step: "type" });
  });
  it("drops the website step only when nothing asks for it", () => {
    const loc = { ...fakeRequirements("local", "EG"), websiteVerification: "optional" as const };
    expect(stepsFor(loc, false)).not.toContain("website");
    expect(stepsFor(loc, true)).toContain("website");
    expect(stepsFor(fakeRequirements("global", "DE"), false)).toContain("website");
  });
});

describe("review gating", () => {
  it("lists every blocker", () => {
    expect(submitBlockers({ strongFactor: false, detailsOk: false, checklistComplete: false, domainRequired: true, domainVerified: false, declared: false }))
      .toEqual(["no_strong_factor", "details_incomplete", "documents_incomplete", "domain_unverified", "not_declared"]);
    expect(submitBlockers({ strongFactor: true, detailsOk: true, checklistComplete: true, domainRequired: false, domainVerified: false, declared: true })).toEqual([]);
  });
});

describe("status timeline", () => {
  it("maps statuses to phases", () => {
    expect(timeline("SUBMITTED").steps.map((s) => s.state)).toEqual(["done", "current", "upcoming", "upcoming"]);
    expect(timeline("IN_REVIEW").steps.map((s) => s.state)).toEqual(["done", "done", "current", "upcoming"]);
    expect(timeline("NEEDS_INFO").phase).toBe("needs_info");
    expect(timeline("APPROVED").steps.every((s) => s.state === "done")).toBe(true);
    expect(timeline("WITHDRAWN").phase).toBe("withdrawn");
  });
  it("shows expected time only from the server field", () => {
    const now = Date.parse("2026-10-11T00:00:00Z");
    expect(expectedTime({ status: "IN_REVIEW", decisionDueAt: null }, now)).toEqual({ kind: "none" });
    expect(expectedTime({ status: "IN_REVIEW", decisionDueAt: "2026-10-14T00:00:00Z" }, now).kind).toBe("due");
    expect(expectedTime({ status: "IN_REVIEW", decisionDueAt: "2026-10-01T00:00:00Z" }, now).kind).toBe("overdue");
    expect(expectedTime({ status: "NEEDS_INFO", decisionDueAt: "2026-10-14T00:00:00Z" }, now).kind).toBe("none");
  });
  it("computes appeal window and cooldown", () => {
    const app = { appealUsed: false, allowedActions: ["appeal" as const], decision: { decision: "rejected" as const, reasonCode: "other" as const, message: { ar: "", en: "" }, decidedAt: "2026-10-01T00:00:00Z", reapplyAfter: "2026-10-31T00:00:00Z", appealAllowed: true } };
    const v = rejectionView(app, Date.parse("2026-10-11T00:00:00Z"));
    expect(v.canAppeal).toBe(true);
    expect(v.canReapplyNow).toBe(false);
    expect(rejectionView(app, Date.parse("2026-12-01T00:00:00Z"))).toMatchObject({ canAppeal: false, canReapplyNow: true });
    expect(rejectionView({ ...app, appealUsed: true }, Date.parse("2026-10-11T00:00:00Z")).canAppeal).toBe(false);
  });
  it("requires every requested item before resubmit", () => {
    const items = [
      { code: "a", kind: "document" as const, message: { ar: "", en: "" }, satisfied: true },
      { code: "b", kind: "field" as const, message: { ar: "", en: "" }, satisfied: false },
    ];
    expect(resubmitReady(items, new Set())).toBe(false);
    expect(resubmitReady(items, new Set(["b"]))).toBe(true);
  });
});

describe("InMemoryBrandApplyPort", () => {
  const fast = () => new InMemoryBrandApplyPort({ latencyMs: 0, scanMs: 0 });
  it("enforces strong factor, checklist and walks to SUBMITTED", async () => {
    const p = fast();
    await p.verifyOtp({ challengeId: "x", code: "123456" });
    const a: ApplicationView = await p.createApplication({ kind: "local", country: "EG", brandName: "Nile" });
    await expect(p.submit(a.id)).rejects.toMatchObject({ code: "strong_factor_required" });
    await p.totpConfirm("123456");
    await expect(p.submit(a.id)).rejects.toMatchObject({ code: "checklist_incomplete" });
    await p.updateApplication(a.id, { values: { legal_name: "Nile Atelier LLC", commercial_register_no: "123456", tax_card_no: "123456789", signatory_full_name: "Omar Said", signatory_national_id: "29001011234567", signatory_date_of_birth: "1990-01-01", contact_name: "Omar", contact_email: "o@nile.com" } }, null);
    for (const code of ["commercial_register", "tax_card", "signatory_id", "trademark_certificate"]) {
      await p.uploadDocument(a.id, { requirementCode: code, contentType: "application/pdf", sizeBytes: 100, uri: "x" }, () => undefined);
    }
    expect((await p.submit(a.id)).status).toBe("SUBMITTED");
  });
  it("rejects wrong codes", async () => {
    await expect(fast().verifyOtp({ challengeId: "x", code: "000000" })).rejects.toMatchObject({ code: "invalid_code" });
  });
});
