import { describe, expect, it } from "vitest";
import {
  FakeDnsResolver,
  FakeSanctionsScreening,
  FakeVerificationEmail,
  FixtureTrademarkRegistry,
  InMemoryBrandVerificationStore,
  StaticVerificationSecret,
} from "./adapters/in-memory";
import { UnconfiguredSanctionsScreening, UnconfiguredTrademarkRegistry } from "./adapters/production-adapters";
import { BrandVerificationService } from "./application/service";
import type { SanctionsScreeningPort, TrademarkRegistryPort } from "./domain/ports";
import { FakeClock, fakeIds, snapshot, U } from "./test/fixtures";

function make(over: { registry?: TrademarkRegistryPort; sanctions?: SanctionsScreeningPort } = {}) {
  const store = new InMemoryBrandVerificationStore();
  const clock = new FakeClock();
  const dns = new FakeDnsResolver();
  const registry = new FixtureTrademarkRegistry();
  const email = new FakeVerificationEmail();
  const svc = new BrandVerificationService({
    store, clock, ids: fakeIds(), dns, registry: over.registry ?? registry, sanctions: over.sanctions ?? new FakeSanctionsScreening(), email, secret: new StaticVerificationSecret(),
  });
  return { store, clock, dns, registry, email, svc };
}

describe("DNS TXT verification", () => {
  it("returns the record, stays pending until the TXT appears, then verifies and is idempotent", async () => {
    const t = make();
    const s = snapshot(1);
    const started = await t.svc.startDomainVerification({ snapshot: s, rawDomain: "WWW.Lumen-Atelier.com", method: "dns_txt" });
    if (started.kind !== "started") throw new Error("expected started");
    const v = started.verification;
    expect(v.txtRecordName).toBe("_zoutlet-verify.lumen-atelier.com");
    expect(v.txtRecordValue).toMatch(/^zoutlet-site-verification=[0-9a-f]{64}$/);
    // restarting with the same inputs returns the same challenge
    const again = await t.svc.startDomainVerification({ snapshot: s, rawDomain: "lumen-atelier.com", method: "dns_txt" });
    expect(again).toEqual(started);
    expect((await t.svc.confirmDomainVerification({ snapshot: s })).kind).toBe("pending");
    t.dns.set(v.txtRecordName as string, ['"unrelated"', `"${v.txtRecordValue as string}"`]);
    const done = await t.svc.confirmDomainVerification({ snapshot: s });
    expect(done.kind).toBe("confirmed");
    expect(await t.svc.confirmDomainVerification({ snapshot: s })).toMatchObject({ kind: "confirmed" });
    expect(t.store.outbox.filter((e) => e.eventType === "brand_domain.verified")).toHaveLength(1);
    expect((await t.store.getClaim(s.applicationId))?.domainVerifiedAtMs).toBe(t.clock.nowMs());
  });

  it("a token for another application or nonce never verifies; DNS errors stay pending", async () => {
    const t = make();
    const a = snapshot(1);
    const b = snapshot(2, { websiteDomain: "lumen-atelier.com" });
    const sa = await t.svc.startDomainVerification({ snapshot: a, rawDomain: "lumen-atelier.com", method: "dns_txt" });
    const sb = await t.svc.startDomainVerification({ snapshot: b, rawDomain: "lumen-atelier.com", method: "dns_txt" });
    if (sa.kind !== "started" || sb.kind !== "started") throw new Error("expected started");
    expect(sa.verification.txtRecordValue).not.toBe(sb.verification.txtRecordValue);
    t.dns.set("_zoutlet-verify.lumen-atelier.com", [sa.verification.txtRecordValue as string]);
    expect((await t.svc.confirmDomainVerification({ snapshot: b })).kind).toBe("pending");
    t.dns.setError("_zoutlet-verify.lumen-atelier.com");
    expect((await t.svc.confirmDomainVerification({ snapshot: a })).kind).toBe("pending");
  });

  it("expires after 7 days", async () => {
    const t = make();
    const s = snapshot(1);
    await t.svc.startDomainVerification({ snapshot: s, rawDomain: "lumen-atelier.com", method: "dns_txt" });
    t.clock.advance(7 * 86_400_000 + 1);
    expect((await t.svc.confirmDomainVerification({ snapshot: s })).kind).toBe("expired");
    expect((await t.svc.confirmDomainVerification({ snapshot: s })).kind).toBe("expired");
  });

  it("rejects SSRF-shaped and free-mail domains", async () => {
    const t = make();
    for (const raw of ["127.0.0.1", "localhost", "http://a.com", "gmail.com", "intranet.local", "com.eg"]) {
      expect((await t.svc.startDomainVerification({ snapshot: snapshot(1), rawDomain: raw, method: "dns_txt" })).kind).toBe("invalid_domain");
    }
    expect(await t.store.getDomainVerification(U(101))).toBeNull();
  });
});

describe("email-at-domain verification", () => {
  it("sends a code to an allowed mailbox on the brand domain and verifies it", async () => {
    const t = make();
    const s = snapshot(1);
    const r = await t.svc.startDomainVerification({ snapshot: s, rawDomain: "lumen-atelier.com", method: "email", emailLocalPart: "info" });
    expect(r).toMatchObject({ kind: "started", verification: { emailSentToMasked: "i***@lumen-atelier.com" } });
    expect(t.email.sent).toHaveLength(1);
    expect(t.email.sent[0]?.to).toBe("info@lumen-atelier.com");
    const code = t.email.sent[0]?.code as string;
    expect(code).toMatch(/^\d{6}$/);
    expect(JSON.stringify(await t.store.getDomainVerification(s.applicationId))).not.toContain(code);
    expect((await t.svc.confirmDomainVerification({ snapshot: s })).kind).toBe("code_required");
    expect((await t.svc.confirmDomainVerification({ snapshot: s, code })).kind).toBe("confirmed");
  });

  it("locks after 5 wrong codes even when the right code follows", async () => {
    const t = make();
    const s = snapshot(1);
    await t.svc.startDomainVerification({ snapshot: s, rawDomain: "lumen-atelier.com", method: "email", emailLocalPart: "admin" });
    const code = t.email.sent[0]?.code as string;
    const wrong = code === "000000" ? "111111" : "000000";
    const results = [];
    for (let i = 0; i < 5; i += 1) results.push(await t.svc.confirmDomainVerification({ snapshot: s, code: wrong }));
    expect(results.slice(0, 4).map((r) => r.kind)).toEqual(["wrong_code", "wrong_code", "wrong_code", "wrong_code"]);
    expect(results[0]).toMatchObject({ attemptsRemaining: 4 });
    expect(results[4]?.kind).toBe("locked");
    expect((await t.svc.confirmDomainVerification({ snapshot: s, code })).kind).toBe("locked");
  });

  it("expires after 24h and requires a mailbox part; unavailable email stores nothing", async () => {
    const t = make();
    const s = snapshot(1);
    expect(await t.svc.startDomainVerification({ snapshot: s, rawDomain: "lumen-atelier.com", method: "email" })).toEqual({ kind: "invalid_domain", reason: "email_local_part_required" });
    t.email.next = "unavailable";
    expect((await t.svc.startDomainVerification({ snapshot: s, rawDomain: "lumen-atelier.com", method: "email", emailLocalPart: "info" })).kind).toBe("email_unavailable");
    expect(await t.store.getDomainVerification(s.applicationId)).toBeNull();
    t.email.next = "sent";
    await t.svc.startDomainVerification({ snapshot: s, rawDomain: "lumen-atelier.com", method: "email", emailLocalPart: "info" });
    const code = t.email.sent[0]?.code as string;
    t.clock.advance(24 * 3_600_000);
    expect((await t.svc.confirmDomainVerification({ snapshot: s, code })).kind).toBe("expired");
  });
});

describe("no enumeration of other applicants", () => {
  it("a domain verified by someone else returns the same shape as a fresh claim and opens a silent conflict", async () => {
    const t = make();
    const first = snapshot(1);
    const startedFirst = await t.svc.startDomainVerification({ snapshot: first, rawDomain: "lumen-atelier.com", method: "dns_txt" });
    if (startedFirst.kind !== "started") throw new Error("x");
    t.dns.set("_zoutlet-verify.lumen-atelier.com", [startedFirst.verification.txtRecordValue as string]);
    await t.svc.confirmDomainVerification({ snapshot: first });
    const lone = make();
    const loneStart = await lone.svc.startDomainVerification({ snapshot: snapshot(2, { brandName: "Other", trademark: null }), rawDomain: "fresh-domain.com", method: "dns_txt" });
    const second = snapshot(2, { brandName: "Different Name", trademark: null });
    const startedSecond = await t.svc.startDomainVerification({ snapshot: second, rawDomain: "lumen-atelier.com", method: "dns_txt" });
    if (startedSecond.kind !== "started" || loneStart.kind !== "started") throw new Error("x");
    expect(Object.keys(startedSecond.verification).sort()).toEqual(Object.keys(loneStart.verification).sort());
    expect(startedSecond.verification.status).toBe("pending");
    const conflicts = await t.store.listConflictsFor(second.applicationId);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.reasons).toContain("same_domain");
    expect(conflicts[0]?.applicationIds).toEqual([first.applicationId, second.applicationId].sort());
  });

  it("detects the first verified claim as priority 1 and resolves keep_first, replaying the same outcome", async () => {
    const t = make();
    const a = snapshot(1);
    const b = snapshot(2, { websiteDomain: null, trademark: null });
    await t.svc.detectConflicts(b);
    const sa = await t.svc.startDomainVerification({ snapshot: a, rawDomain: "lumen-atelier.com", method: "dns_txt" });
    if (sa.kind !== "started") throw new Error("x");
    t.dns.set("_zoutlet-verify.lumen-atelier.com", [sa.verification.txtRecordValue as string]);
    await t.svc.confirmDomainVerification({ snapshot: a });
    const detA = await t.svc.detectConflicts(a);
    const detB = await t.svc.detectConflicts(b);
    expect(detA.conflicts).toHaveLength(1);
    expect(detA.priorityRank).toBe(1);
    expect(detB.priorityRank).toBe(2);
    const r = await t.svc.resolveConflict({ applicationId: b.applicationId, outcome: "keep_first", actorId: U(900), internalNote: "ownership proven by DNS" });
    expect(r).toMatchObject({ kind: "resolved", conflict: { winnerApplicationId: a.applicationId, outcome: "keep_first" } });
    expect((await t.svc.resolveConflict({ applicationId: a.applicationId, outcome: "keep_first", actorId: U(901), internalNote: "again" })).kind).toBe("replayed");
    expect((await t.svc.resolveConflict({ applicationId: a.applicationId, outcome: "reject_all", actorId: U(901), internalNote: "other" })).kind).toBe("already_resolved_differently");
    expect((await t.svc.resolveConflict({ applicationId: U(4040), outcome: "keep_first", actorId: U(901), internalNote: "x" })).kind).toBe("not_found");
    const event = t.store.outbox.find((e) => e.eventType === "brand_claim_conflict.resolved");
    expect(JSON.stringify(event)).not.toMatch(/ownership proven/);
  });

  it("replace_with_this names the requesting application as winner; same applicant never conflicts", async () => {
    const t = make();
    const a = snapshot(1);
    const b = snapshot(2);
    await t.svc.detectConflicts(a);
    await t.svc.detectConflicts(b);
    const r = await t.svc.resolveConflict({ applicationId: b.applicationId, outcome: "replace_with_this", actorId: U(900), internalNote: "n" });
    expect(r).toMatchObject({ kind: "resolved", conflict: { winnerApplicationId: b.applicationId } });
    const same = snapshot(3, { applicantId: a.applicantId });
    expect((await t.svc.detectConflicts(same)).conflicts.filter((c) => c.applicationIds.includes(a.applicationId))).toEqual([]);
  });
});

describe("trademark and auto checks", () => {
  it("records a matching registry owner as evidence and stamps the claim", async () => {
    const t = make();
    t.registry.seed("EUIPO", "018123456", { kind: "found", record: { ownerName: "LUMEN ATELIER S.A.S.", markText: "LUMEN", classes: [18, 25], status: "registered", registeredOn: "2020-01-02", expiresOn: "2030-01-02" } });
    const r = await t.svc.recordTrademarkLookup({ snapshot: snapshot(1), mode: "auto", actorId: U(900) });
    expect(r).toMatchObject({ kind: "recorded", evidence: { found: true, ownerMatchesApplicant: "yes" } });
    const claim = await t.store.getClaim(U(101));
    expect(claim?.trademarkKey).toBe("EUIPO:018123456");
    expect(claim?.trademarkMatchedAtMs).toBe(t.clock.nowMs());
    expect(await t.svc.recordTrademarkLookup({ snapshot: snapshot(1, { trademark: null }), mode: "auto", actorId: null })).toEqual({ kind: "no_trademark_claimed" });
  });

  it("manual evidence with a different owner reads as no match", async () => {
    const t = make();
    const r = await t.svc.recordTrademarkLookup({
      snapshot: snapshot(1), mode: "manual", actorId: U(900),
      manual: { office: "WIPO", registerNumber: "1", found: true, ownerName: "Completely Different Holdings", status: "registered" },
    });
    expect(r).toMatchObject({ kind: "recorded", evidence: { ownerMatchesApplicant: "no", source: "manual" } });
    expect((await t.store.getClaim(U(101)))?.trademarkMatchedAtMs ?? null).toBeNull();
  });

  it("aggregates a low-risk report for a clean local brand and is deterministic", async () => {
    const t = make();
    const s = snapshot(1, { kind: "local", country: "EG", trademark: null, websiteDomain: null, brandName: "Nile Cotton", legalName: "Nile Cotton LLC" });
    const r = await t.svc.runAutoChecks(s);
    expect(r.risk).toBe("low");
    expect(r.dualApprovalRequired).toBe(false);
    expect(r.checks.map((c) => `${c.code}:${c.result}`)).toEqual(["country_policy:pass", "domain_verified:skipped", "trademark_owner:skipped", "sanctions:pass", "duplicate_claim:pass"]);
    expect((await t.store.latestReport(s.applicationId))?.report).toEqual(r);
    expect(t.store.outbox.filter((e) => e.eventType === "brand_verification.checks_completed")).toHaveLength(1);
  });

  it("fails closed with check errors when providers are unconfigured and flags medium risk", async () => {
    const t = make({ registry: new UnconfiguredTrademarkRegistry(), sanctions: new UnconfiguredSanctionsScreening() });
    const r = await t.svc.runAutoChecks(snapshot(1));
    expect(r.checks.find((c) => c.code === "trademark_owner")?.result).toBe("error");
    expect(r.checks.find((c) => c.code === "sanctions")?.result).toBe("error");
    expect(r.risk).not.toBe("low");
    expect(r.forceManualTrademark).toBe(true);
    await expect(t.svc.recordTrademarkLookup({ snapshot: snapshot(1), mode: "auto", actorId: U(1) })).rejects.toMatchObject({ status: 503 });
  });

  it("requires dual approval for GLOBAL + high-risk country and for a sanctions warning", async () => {
    const t = make();
    const hr = await t.svc.runAutoChecks(snapshot(1, { country: "MM", brandName: "Zed", legalName: "Zed Co" }));
    expect(hr.dualApprovalRequired).toBe(true);
    expect(hr.risk).toBe("high");
    const warn = await t.svc.runAutoChecks(snapshot(2, { legalName: "SimilarCorp Ltd", brandName: "Qux" }));
    expect(warn.dualApprovalRequired).toBe(true);
    const fail = await t.svc.runAutoChecks(snapshot(3, { legalName: "BlockedCorp", brandName: "Quux" }));
    expect(fail.risk).toBe("high");
    expect(fail.reasons).toContain("sanctions_hit");
    const blocked = await t.svc.runAutoChecks(snapshot(4, { country: "KP", brandName: "Kappa" }));
    expect(blocked.reasons).toContain("country_not_supported");
  });
});
