import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AdminBrandApplicationWire, BrandApplicationWire, BrandDocumentWire, BrandQueueItemWire } from "../api/brand-schemas";
import { buildCsp } from "../security/csp";
import { readDocumentOrigin } from "../api/config";
import { BRAND_CLIENT_KEYS } from "./brand-labels";
import { en } from "../i18n/en";
import {
  approveConsequence, approveNeedsCosign, availability, checklist, conflictView, countLabel, documentState, flashCode, flashFor,
  moveSelection, nameMatchScore, needsInfoCandidates, parseQueueFilters, queueApiQuery, queueRows, queueSearch, resolveShortcut,
  riskBand, riskScoreOf, slaView, trademarkView, urlLooksValid, urlRemainingMs, validateDecision, validateNote, watermarkText,
  type ActionContext, type KeyEvent,
} from "./brand-review";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-10-11T10:00:00Z");

describe("queue filters to query", () => {
  it("parses only enumerated values and drops junk", () => {
    expect(parseQueueFilters({ status: "IN_REVIEW", kind: "global", country: "de", assignee: "me", sla_breached: "true", cursor: "abc" }))
      .toEqual({ status: "IN_REVIEW", kind: "global", country: "DE", assignee: "me", slaBreached: true, cursor: "abc" });
    expect(parseQueueFilters({ status: "HACKED", kind: "x", country: "EGY", assignee: "everyone", sla_breached: "false" })).toEqual({});
    expect(parseQueueFilters({ status: ["SUBMITTED", "APPROVED"] })).toEqual({ status: "SUBMITTED" });
    expect(parseQueueFilters({ cursor: "x".repeat(513) })).toEqual({});
  });
  it("maps filters to the API query and never sends sla_breached=false", () => {
    expect(queueApiQuery({ status: "IN_REVIEW", slaBreached: true, assignee: "unassigned", country: "EG", kind: "local", cursor: "c" }))
      .toEqual({ status: "IN_REVIEW", kind: "local", country: "EG", assignee: "unassigned", sla_breached: true, cursor: "c" });
    expect(queueApiQuery({})).toEqual({});
  });
  it("round-trips through the URL", () => {
    fc.assert(fc.property(
      fc.record({
        status: fc.option(fc.constantFrom("SUBMITTED", "IN_REVIEW", "NEEDS_INFO", "APPROVED"), { nil: undefined }),
        kind: fc.option(fc.constantFrom("local", "global"), { nil: undefined }),
        country: fc.option(fc.constantFrom("EG", "DE", "US"), { nil: undefined }),
        assignee: fc.option(fc.constantFrom("me", "unassigned", "any"), { nil: undefined }),
        slaBreached: fc.option(fc.constant(true), { nil: undefined }),
      }),
      (raw) => {
        const f = parseQueueFilters(Object.fromEntries(Object.entries({ ...raw, sla_breached: raw.slaBreached === true ? "true" : undefined }).filter(([, v]) => v !== undefined)) as Record<string, string>);
        const again = parseQueueFilters(Object.fromEntries(new URLSearchParams(queueSearch(f))));
        expect(again).toEqual(f);
      },
    ));
  });
  it("puts the cursor in the link only when asked", () => {
    expect(queueSearch({ status: "SUBMITTED" })).toBe("?status=SUBMITTED");
    expect(queueSearch({ status: "SUBMITTED" }, "n1")).toBe("?status=SUBMITTED&cursor=n1");
    expect(queueSearch({})).toBe("");
  });
});

describe("SLA countdown and risk", () => {
  const due = new Date(NOW + 2 * 86_400_000 + 3_600_000).toISOString();
  const sub = new Date(NOW - 3 * 86_400_000).toISOString();
  it("counts down from the SERVER time and reports consumption", () => {
    const v = slaView({ status: "IN_REVIEW", submittedAtIso: sub, dueAtIso: due }, NOW);
    expect(v.clock).toEqual({ overdue: false, unit: "days", amount: 2 });
    expect(v.breached).toBe(false);
    expect(v.elapsed).toBeGreaterThan(0.55);
    expect(v.elapsed).toBeLessThan(0.65);
  });
  it("is breached after the due time or when the server says so", () => {
    expect(slaView({ status: "IN_REVIEW", submittedAtIso: sub, dueAtIso: due }, NOW + 5 * 86_400_000).breached).toBe(true);
    expect(slaView({ status: "IN_REVIEW", submittedAtIso: sub, dueAtIso: due, serverBreached: true }, NOW).breached).toBe(true);
    expect(slaView({ status: "IN_REVIEW", submittedAtIso: null, dueAtIso: due }, NOW + 9e9).elapsed).toBe(1);
  });
  it("stops the clock on terminal statuses", () => {
    expect(slaView({ status: "APPROVED", submittedAtIso: sub, dueAtIso: due }, NOW + 9e9)).toEqual({ clock: null, breached: false, elapsed: 1 });
  });
  it("bands risk and reads the risk_score check", () => {
    expect([undefined, 0, 29, 30, 69, 70, 100].map(riskBand)).toEqual(["unknown", "low", "low", "medium", "medium", "high", "high"]);
    const ran = "2026-10-11T09:00:00Z";
    expect(riskScoreOf([{ code: "risk_score", result: "warn", detail: "score 64 of 100", ran_at: ran }])).toBe(64);
    expect(riskScoreOf([{ code: "risk_score", result: "warn", detail: "score 640", ran_at: ran }])).toBeUndefined();
    expect(riskScoreOf([])).toBeUndefined();
  });
  it("sorts breached first then soonest due, using the server clock", () => {
    const item = (id: string, dueMs: number, extra: Partial<BrandQueueItemWire> = {}): BrandQueueItemWire => ({
      id, brand_name: id, brand_kind: "local", country: "EG", status: "IN_REVIEW", submitted_at: new Date(NOW - 86_400_000).toISOString(),
      decision_due_at: new Date(dueMs).toISOString(), ...extra,
    });
    const rows = queueRows([item("b", NOW + 1000), item("a", NOW + 500), item("late", NOW - 1000, { assignee_id: U1 })], NOW, U1);
    expect(rows.map((r) => r.id)).toEqual(["late", "a", "b"]);
    expect(rows[0]?.assignedToMe).toBe(true);
    expect(rows[1]?.unassigned).toBe(true);
  });
  it("labels capped counts honestly", () => {
    expect(countLabel(50, true)).toBe("50+");
    expect(countLabel(3, false)).toBe("3");
  });
});

describe("action availability by status and role", () => {
  const base: ActionContext = { status: "IN_REVIEW", assigneeId: U1, selfId: U1, roles: ["ops"], pendingCosign: false, duplicateCount: 0, postureWritesEnabled: true };
  it("lets the assignee decide on an IN_REVIEW application", () => {
    const a = availability(base);
    expect([a.approve, a.reject, a.needsInfo, a.release, a.readDocuments, a.trademarkLookup].every((g) => g.allowed)).toBe(true);
    expect(a.claim.reasonKey).toBe("brand.gate.alreadyClaimed");
  });
  it("requires a claim first, and refuses non-assignees", () => {
    expect(availability({ ...base, assigneeId: null }).approve.reasonKey).toBe("brand.gate.claimFirst");
    expect(availability({ ...base, assigneeId: null }).claim.allowed).toBe(true);
    expect(availability({ ...base, assigneeId: U2 }).approve.reasonKey).toBe("brand.gate.notAssignee");
    expect(availability({ ...base, assigneeId: U2 }).readDocuments.allowed).toBe(false);
    expect(availability({ ...base, assigneeId: U2, roles: ["super_admin"] }).release.allowed).toBe(true);
    expect(availability({ ...base, assigneeId: U2 }).release.allowed).toBe(false);
  });
  it("offers nothing on terminal statuses", () => {
    for (const status of ["APPROVED", "REJECTED", "WITHDRAWN"] as const) {
      const a = availability({ ...base, status });
      expect(a.approve.allowed || a.claim.allowed || a.trademarkLookup.allowed).toBe(false);
    }
  });
  it("hides review actions from roles without the review scope, and unknown roles show all", () => {
    expect(availability({ ...base, roles: ["finance"] }).approve.reasonKey).toBe("brand.gate.role");
    expect(availability({ ...base, roles: ["support"] }).claim.allowed).toBe(false);
    expect(availability({ ...base, roles: null }).approve.allowed).toBe(true);
  });
  it("cosign needs a pending cosign and a different admin than the decider", () => {
    expect(availability(base).cosign.reasonKey).toBe("brand.gate.noCosign");
    const pending = { ...base, pendingCosign: true };
    expect(availability(pending).cosign.reasonKey).toBe("brand.gate.cosignSelf");
    expect(availability(pending).approve.reasonKey).toBe("brand.gate.awaitingCosign");
    expect(availability({ ...pending, selfId: U2 }).cosign.allowed).toBe(true);
  });
  it("conflict resolution is trust_safety only and needs a duplicate", () => {
    expect(availability({ ...base, duplicateCount: 1 }).resolveConflict.reasonKey).toBe("brand.gate.conflictRole");
    expect(availability({ ...base, duplicateCount: 1, roles: ["trust_safety"] }).resolveConflict.allowed).toBe(true);
    expect(availability({ ...base, duplicateCount: 0, roles: ["trust_safety"] }).resolveConflict.reasonKey).toBe("brand.gate.noConflict");
  });
  it("turns writes off when the posture says so", () => {
    expect(availability({ ...base, postureWritesEnabled: false }).approve.reasonKey).toBe("brand.gate.posture");
  });
  it("tells the reviewer exactly what approve does", () => {
    expect(approveConsequence({ pendingCosignRequired: false })).toEqual(["brand.approve.createsStore", "brand.approve.createsOwner", "brand.approve.notifies"]);
    expect(approveConsequence({ pendingCosignRequired: true })[0]).toBe("brand.approve.cosignFirst");
  });
});

describe("decision form validation", () => {
  const input = { decision: "reject", reasonCode: "ownership_not_proven", messageAr: "لم يثبت الملك", messageEn: "Ownership not proven", items: [], internalNote: "", reapplyAfterDays: "", slug: "" };
  it("accepts a complete reject and builds the wire body", () => {
    const r = validateDecision({ ...input, reapplyAfterDays: "45", internalNote: " n " });
    expect(r).toEqual({ ok: true, body: { decision: "reject", reason_code: "ownership_not_proven", public_message_ar: "لم يثبت الملك", public_message_en: "Ownership not proven", reapply_after_days: 45, internal_note: "n" } });
  });
  it("requires both public messages in the right script on reject", () => {
    const r = validateDecision({ ...input, messageAr: "", messageEn: "" });
    expect(r.ok === false && r.errors).toEqual({ messageAr: "brand.err.messageAr", messageEn: "brand.err.messageEn" });
    const s = validateDecision({ ...input, messageAr: "English only", messageEn: "عربي فقط" });
    expect(s.ok === false && s.errors).toEqual({ messageAr: "brand.err.messageArScript", messageEn: "brand.err.messageEnScript" });
  });
  it("rejects bad reason codes, reapply values and long text", () => {
    expect(validateDecision({ ...input, reasonCode: "nope" }).ok).toBe(false);
    expect(validateDecision({ ...input, reasonCode: "ok" }).ok).toBe(false);
    for (const bad of ["-1", "366", "1.5", "abc"]) expect(validateDecision({ ...input, reapplyAfterDays: bad }).ok, bad).toBe(false);
    expect(validateDecision({ ...input, messageEn: "a".repeat(1001) }).ok).toBe(false);
    expect(validateDecision({ ...input, internalNote: "x".repeat(4001) }).ok).toBe(false);
  });
  it("approve needs reason ok and a valid optional slug, and sends no public messages", () => {
    const a = { ...input, decision: "approve", reasonCode: "ok" };
    expect(validateDecision(a)).toEqual({ ok: true, body: { decision: "approve", reason_code: "ok" } });
    expect(validateDecision({ ...a, slug: "my-brand-2" })).toEqual({ ok: true, body: { decision: "approve", reason_code: "ok", slug: "my-brand-2" } });
    for (const bad of ["My Brand", "-x", "x-", "a--b", "x".repeat(61)]) expect(validateDecision({ ...a, slug: bad }).ok, bad).toBe(false);
    expect(validateDecision({ ...a, reasonCode: "other" }).ok).toBe(false);
  });
  it("needs_info needs items, messages and sends one entry per item", () => {
    const n = { ...input, decision: "needs_info", reasonCode: "incomplete_information" };
    expect(validateDecision(n).ok).toBe(false);
    const ok = validateDecision({ ...n, items: [{ code: "commercial_register", kind: "document" }, { code: "clarification", kind: "clarification" }] });
    expect(ok.ok && (ok.body.requested_items as unknown[]).length).toBe(2);
    expect(validateDecision({ ...n, items: Array.from({ length: 21 }, (_, i) => ({ code: `c${i}`, kind: "document" })) }).ok).toBe(false);
    expect(validateDecision({ ...n, items: [{ code: "x", kind: "weird" }] }).ok).toBe(false);
    expect(validateDecision({ ...input, decision: "maybe" }).ok).toBe(false);
  });
  it("cosign and conflict notes are required and bounded", () => {
    expect(validateNote("  ")).toEqual({ ok: false, error: "brand.err.note" });
    expect(validateNote(" ok ")).toEqual({ ok: true, note: "ok" });
    expect(validateNote("x".repeat(4001)).ok).toBe(false);
  });
  it("never accepts a body with a field the API contract does not define", () => {
    fc.assert(fc.property(fc.string(), fc.string(), (ar, en) => {
      const r = validateDecision({ ...input, messageAr: ar, messageEn: en });
      if (r.ok) expect(Object.keys(r.body).every((k) => ["decision", "reason_code", "public_message_ar", "public_message_en", "reapply_after_days", "internal_note"].includes(k))).toBe(true);
    }));
  });
});

const doc = (over: Partial<BrandDocumentWire> = {}): BrandDocumentWire => ({
  id: U1, requirement_code: "commercial_register", content_type: "application/pdf", size_bytes: 10, upload_status: "uploaded",
  scan_status: "clean", review_status: "unreviewed", created_at: "2026-10-01T00:00:00Z", ...over,
});
const app = (over: Partial<BrandApplicationWire> = {}): BrandApplicationWire => ({
  id: U1, status: "IN_REVIEW", brand_kind: "global", country: "DE", brand_name: "Acme", documents: [], requested_items: [],
  created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-02T00:00:00Z", ...over,
});
const admin = (a: BrandApplicationWire, over: Partial<AdminBrandApplicationWire> = {}): AdminBrandApplicationWire => ({
  application: a, assignee_id: U1, decision_due_at: "2026-10-12T00:00:00Z", pending_cosign: false, auto_checks: [], history: [], ...over,
});

describe("checklist and documents", () => {
  it("derives a per-document state", () => {
    expect(documentState(doc())).toBe("to_review");
    expect(documentState(doc({ review_status: "accepted" }))).toBe("accepted");
    expect(documentState(doc({ review_status: "unreadable" }))).toBe("rejected");
    expect(documentState(doc({ scan_status: "pending" }))).toBe("scanning");
    expect(documentState(doc({ scan_status: "infected" }))).toBe("blocked");
    expect(documentState(doc({ upload_status: "awaiting_upload" }))).toBe("missing");
  });
  it("groups by requirement, ranks the worst state and flags requested items; only clean uploads are viewable", () => {
    const a = app({
      documents: [doc({ id: U1 }), doc({ id: U2, scan_status: "infected" }), doc({ id: "33333333-3333-4333-8333-333333333333", requirement_code: "tax_card", review_status: "accepted" })],
      requested_items: [{ code: "board_letter", kind: "document", message_ar: "ا", message_en: "a" }, { code: "tax_card", kind: "document", message_ar: "ا", message_en: "a", satisfied: true }],
    });
    const rows = checklist(a);
    expect(rows.map((r) => [r.code, r.state])).toEqual([["board_letter", "missing"], ["commercial_register", "blocked"], ["tax_card", "accepted"]]);
    expect(rows[1]?.documents.map((d) => d.viewable)).toEqual([true, false]);
    expect(rows[0]?.requested?.code).toBe("board_letter");
    expect(rows[2]?.requested).toBeNull();
  });
  it("offers needs-info candidates that exclude accepted documents", () => {
    const a = app({ documents: [doc(), doc({ id: U2, requirement_code: "tax_card", review_status: "accepted" })], website_domain: "acme.com" });
    expect(needsInfoCandidates(a).map((c) => c.code)).toEqual(["commercial_register", "domain_verification", "clarification"]);
  });
});

describe("document viewer clocks", () => {
  it("counts the signed URL down from server time plus monotonic elapsed, not the device clock", () => {
    const p = { expiresAtMs: NOW + 900_000, serverNowAtReceiptMs: NOW };
    expect(urlRemainingMs({ ...p, elapsedSinceReceiptMs: 0 })).toBe(900_000);
    expect(urlRemainingMs({ ...p, elapsedSinceReceiptMs: 899_000 })).toBe(1000);
    expect(urlRemainingMs({ ...p, elapsedSinceReceiptMs: 2_000_000 })).toBe(0);
  });
  it("refuses a URL that is already expired or lives past the 15 minute contract", () => {
    expect(urlLooksValid({ expiresAtMs: NOW + 60_000, serverNowMs: NOW })).toBe(true);
    expect(urlLooksValid({ expiresAtMs: NOW - 1, serverNowMs: NOW })).toBe(false);
    expect(urlLooksValid({ expiresAtMs: NOW + 3_600_000, serverNowMs: NOW })).toBe(false);
  });
  it("stamps reviewer, application and server time into the watermark", () => {
    expect(watermarkText(U1, U2, "2026-10-11T10:00:12.000Z")).toBe("11111111 · 22222222 · 2026-10-11 10:00Z");
  });
  it("allows the document origin in the CSP only when configured, https only", () => {
    const o = { nonce: "AAAAAAAAAAAAAAAAAAAAAA==", apiOrigin: null, development: false } as const;
    expect(buildCsp(o)).not.toContain("frame-src");
    const csp = buildCsp({ ...o, documentOrigin: "https://docs.example.com" });
    expect(csp).toContain("img-src 'self' data: https://docs.example.com");
    expect(csp).toContain("frame-src https://docs.example.com");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(readDocumentOrigin({ ADMIN_DOCUMENT_ORIGIN: "http://evil.example.com" })).toBeNull();
    expect(readDocumentOrigin({ ADMIN_DOCUMENT_ORIGIN: "https://docs.example.com/path?x=1" })).toBe("https://docs.example.com");
    expect(readDocumentOrigin({})).toBeNull();
  });
});

describe("trademark evidence", () => {
  it("scores owner-name overlap ignoring legal suffixes, case and Arabic variants", () => {
    expect(nameMatchScore("ACME Trading Ltd.", "Acme Trading")).toBe(100);
    expect(nameMatchScore("Acme Trading", "Globex Holdings")).toBe(0);
    expect(nameMatchScore("شركة النيل للملابس", "النيل للملابس")).toBe(100);
    expect(nameMatchScore("", "x")).toBe(0);
    fc.assert(fc.property(fc.string(), fc.string(), (a, b) => {
      const s = nameMatchScore(a, b);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(100);
      expect(nameMatchScore(b, a)).toBe(s);
    }));
  });
  const ev = { id: U1, source: "WIPO", found: true, retrieved_at: "2026-10-10T00:00:00Z" } as const;
  it("explains the verdict and keeps the server verdict authoritative", () => {
    expect(trademarkView({ ...ev, owner_name: "Other Co", owner_matches_applicant: "no" }, ["Acme"]).explanationKey).toBe("brand.tm.ownerNo");
    expect(trademarkView({ ...ev, owner_name: "Acme Trading", owner_matches_applicant: "yes" }, ["Acme Trading Ltd"]).explanationKey).toBe("brand.tm.ownerYes");
    expect(trademarkView({ ...ev, owner_name: "Acme Trading Ltd", owner_matches_applicant: "unknown" }, ["Acme Trading"]).explanationKey).toBe("brand.tm.ownerUnknownClose");
    expect(trademarkView({ ...ev, owner_name: "Zed", owner_matches_applicant: "unknown" }, ["Acme"]).explanationKey).toBe("brand.tm.ownerUnknown");
    const nf = trademarkView({ ...ev, found: false }, ["Acme"]);
    expect(nf.explanationKey).toBe("brand.tm.notFound");
    expect(nf.score).toBeNull();
  });
  it("sends high-risk global approvals and sanctions flags to cosign", () => {
    expect(approveNeedsCosign(admin(app(), { high_risk_country: true }))).toBe(true);
    expect(approveNeedsCosign(admin(app({ brand_kind: "local" }), { high_risk_country: true }))).toBe(false);
    expect(approveNeedsCosign(admin(app({ brand_kind: "local" }), { auto_checks: [{ code: "sanctions_screen", result: "warn", ran_at: "2026-10-11T00:00:00Z" }] }))).toBe(true);
    expect(approveNeedsCosign(admin(app()))).toBe(false);
  });
});

describe("conflict view model", () => {
  const a = admin(app({ brand_name: "Acme", legal_name: "Acme Ltd", website_domain: "acme.com", submitted_at: "2026-10-02T00:00:00Z" }));
  const b = admin(app({ id: U2, brand_name: "ACME", legal_name: "Acme Trading Co", website_domain: "acme.com", submitted_at: "2026-10-01T00:00:00Z" }), {
    trademark_evidence: [{ id: U2, source: "EUIPO", found: true, owner_name: "Acme SA", register_number: "123", retrieved_at: "2026-10-03T00:00:00Z" }],
  });
  it("lines the two applications up and marks agreeing fields", () => {
    const v = conflictView(a, b);
    expect(v.otherId).toBe(U2);
    const row = (k: string) => v.rows.find((r) => r.field === k);
    expect(row("brand.cmp.brand")?.same).toBe(true);
    expect(row("brand.cmp.domain")?.same).toBe(true);
    expect(row("brand.cmp.legal")?.same).toBe(false);
    expect(row("brand.cmp.tmOwner")).toMatchObject({ current: "—", other: "Acme SA", same: false });
    expect(v.currentIsFirst).toBe(false);
    expect(v.agreeCount + v.differCount).toBe(v.rows.length - 2);
  });
  it("does not call two empty fields the same", () => {
    const v = conflictView(admin(app()), admin(app({ id: U2 })));
    expect(v.rows.find((r) => r.field === "brand.cmp.domain")?.same).toBe(false);
    expect(v.currentIsFirst).toBeNull();
  });
});

describe("keyboard shortcuts", () => {
  const key = (k: string, over: Partial<KeyEvent> = {}): KeyEvent => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, targetTag: "BODY", targetEditable: false, dialogOpen: false, ...over });
  it("resolves scoped single keys", () => {
    expect(resolveShortcut(key("j"), "queue")).toBe("next");
    expect(resolveShortcut(key("j"), "detail")).toBeNull();
    expect(resolveShortcut(key("a"), "detail")).toBe("approve");
    expect(resolveShortcut(key("a"), "queue")).toBeNull();
    expect(resolveShortcut(key("g"), "detail")).toBe("mine");
    expect(resolveShortcut(key("?"), "queue")).toBe("help");
  });
  it("never fires while typing, with modifiers, or with a dialog open", () => {
    expect(resolveShortcut(key("a", { targetTag: "TEXTAREA" }), "detail")).toBeNull();
    expect(resolveShortcut(key("a", { targetTag: "INPUT" }), "detail")).toBeNull();
    expect(resolveShortcut(key("a", { targetEditable: true }), "detail")).toBeNull();
    expect(resolveShortcut(key("a", { metaKey: true }), "detail")).toBeNull();
    expect(resolveShortcut(key("a", { dialogOpen: true }), "detail")).toBeNull();
    expect(resolveShortcut(key("Enter", { targetTag: "A" }), "queue")).toBeNull();
  });
  it("moves the selection without wrapping", () => {
    expect(moveSelection(-1, 3, "next")).toBe(0);
    expect(moveSelection(-1, 3, "prev")).toBe(2);
    expect(moveSelection(2, 3, "next")).toBe(2);
    expect(moveSelection(0, 3, "prev")).toBe(0);
    expect(moveSelection(0, 0, "next")).toBe(-1);
  });
});

describe("write outcomes", () => {
  it("maps the 409 problem codes the review flow defines, and unknown 409s to a stale notice", () => {
    expect(flashCode({ kind: "conflict", code: "already_claimed" })).toBe("conflict.already_claimed");
    expect(flashCode({ kind: "conflict", code: "BAD CODE!" })).toBe("conflict");
    expect(flashCode({ kind: "forbidden" })).toBe("forbidden");
    expect(flashFor("conflict.already_claimed")?.key).toBe("brand.flash.alreadyClaimed");
    expect(flashFor("conflict.reviewer_is_applicant")?.key).toBe("brand.flash.reviewerIsApplicant");
    expect(flashFor("conflict.whatever")?.key).toBe("brand.flash.stale");
    expect(flashFor("forbidden")?.key).toBe("state.forbidden");
    expect(flashFor("ok")?.tone).toBe("ok");
    expect(flashFor("<script>")).toBeNull();
    expect(flashFor(undefined)).toBeNull();
  });
  it("every client label key exists in the catalog", () => {
    for (const k of BRAND_CLIENT_KEYS) expect(Object.hasOwn(en, k), k).toBe(true);
  });
});
