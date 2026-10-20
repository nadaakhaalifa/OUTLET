import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PRINCIPALS, ROLE_PRINCIPALS, bearer, idemKey, uid, type TestPrincipal } from "../test/harness";
import { ADMIN_ROLE_NAMES, type AdminRoleName } from "../domain/bridge";
import { computeDecisionDueAt } from "./domain";
import { APPLICANT, createBrandReviewHarness, makeApplication, type BrandReviewHarness } from "./test/harness";

let h: BrandReviewHarness;
beforeAll(async () => {
  h = await createBrandReviewHarness();
}, 60_000);
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  h.clock.advance(61_000); // fresh rate-limit windows
  h.audit.entries.length = 0;
});

type Method = "get" | "post";
const call = (p: TestPrincipal | null, method: Method, path: string, body?: unknown, key: string | null = method === "post" ? idemKey() : null) => {
  let r = h.http()[method](`/v1${path}`);
  if (p !== null) r = r.set(bearer(p));
  if (key !== null) r = r.set("Idempotency-Key", key);
  return body === undefined ? r : r.send(body as object);
};
const OPS = PRINCIPALS.ops;
const seed = (over: Parameters<typeof makeApplication>[1] = {}) => {
  const a = makeApplication(h.clock.nowMs(), over);
  h.apps.seed(a);
  return a;
};
const base = "/admin/brand-applications";
const DOC = uid(8800);

describe("negative authorization matrix", () => {
  const ALLOWED: AdminRoleName[] = ["ops", "trust_safety"];
  const routes = [
    { name: "GET list", method: "get" as const, path: () => base, body: undefined },
    { name: "GET detail", method: "get" as const, path: () => `${base}/${uid(1)}`, body: undefined },
    { name: "POST claim", method: "post" as const, path: () => `${base}/${uid(1)}/claim`, body: undefined },
    { name: "POST release", method: "post" as const, path: () => `${base}/${uid(1)}/release`, body: undefined },
    {
      name: "POST decision",
      method: "post" as const,
      path: () => `${base}/${uid(1)}/decision`,
      body: { decision: "approve", reason_code: "ok" },
    },
    { name: "POST cosign", method: "post" as const, path: () => `${base}/${uid(1)}/cosign`, body: { internal_note: "second look" } },
    { name: "POST retry-provisioning", method: "post" as const, path: () => `${base}/${uid(1)}/retry-provisioning`, body: undefined },
    {
      name: "POST read-url",
      method: "post" as const,
      path: () => `${base}/${uid(1)}/documents/${DOC}/read-url`,
      body: { reason_code: "kyc_review" },
    },
  ];
  for (const r of routes) {
    it(`${r.name}: unauthenticated is 401, shopper token is 401`, async () => {
      expect((await call(null, r.method, r.path(), r.body)).status).toBe(401);
      expect((await call(PRINCIPALS.shopperOnBuyerAud, r.method, r.path(), r.body)).status).toBe(401);
    });
    for (const role of ADMIN_ROLE_NAMES) {
      const allowed = ALLOWED.includes(role);
      it(`${r.name} as ${role}: ${allowed ? "passes the gate" : "403"}`, async () => {
        const res = await call(ROLE_PRINCIPALS[role], r.method, r.path(), r.body);
        if (allowed) expect(res.status).not.toBe(403);
        else {
          expect(res.status).toBe(403);
          expect(res.body.code).toBe("missing_role");
        }
      });
    }
    it(`${r.name}: no passkey and no grants are 403`, async () => {
      const a = await call(PRINCIPALS.opsNoPasskey, r.method, r.path(), r.body);
      expect(a.status).toBe(403);
      expect(a.body.code).toBe("passkey_required");
      expect((await call(PRINCIPALS.noGrants, r.method, r.path(), r.body)).status).toBe(403);
      expect((await call(PRINCIPALS.opsExpired, r.method, r.path(), r.body)).status).toBe(403);
    });
    it(`${r.name}: standing super_admin without break-glass is 403`, async () => {
      expect((await call(ROLE_PRINCIPALS.super_admin, r.method, r.path(), r.body)).status).toBe(403);
    });
  }
});

describe("queue", () => {
  it("filters, sla_breached and keyset cursor", async () => {
    const now = h.clock.nowMs();
    const a = seed({ decisionDueAtMs: now + 1000, brandName: "A" });
    const b = seed({ decisionDueAtMs: now - 1000, brandName: "B", country: "AE", brandKind: "global" });
    const c = seed({ decisionDueAtMs: now + 2000, status: "NEEDS_INFO", brandName: "C" });
    const d = seed({ decisionDueAtMs: now - 5000, status: "NEEDS_INFO", brandName: "D" }); // paused clock
    const all = await call(OPS, "get", `${base}?limit=50`);
    expect(all.status).toBe(200);
    const ids: string[] = all.body.items.map((i: { id: string }) => i.id);
    for (const x of [a, b, c, d]) expect(ids).toContain(x.id);
    expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id)); // oldest due first

    const breached = await call(OPS, "get", `${base}?sla_breached=true&limit=50`);
    const bIds: string[] = breached.body.items.map((i: { id: string }) => i.id);
    expect(bIds).toContain(b.id);
    expect(bIds).not.toContain(d.id); // NEEDS_INFO pauses the SLA
    expect(breached.body.items.every((i: { sla_breached: boolean }) => i.sla_breached)).toBe(true);

    const ae = await call(OPS, "get", `${base}?country=AE&kind=global&limit=50`);
    expect(ae.body.items.map((i: { id: string }) => i.id)).toContain(b.id);
    expect(ae.body.items.every((i: { country: string }) => i.country === "AE")).toBe(true);

    const p1 = await call(OPS, "get", `${base}?limit=2`);
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.page.has_more).toBe(true);
    const p2 = await call(OPS, "get", `${base}?limit=2&cursor=${encodeURIComponent(p1.body.page.next_cursor)}`);
    const seen = new Set<string>(p1.body.items.map((i: { id: string }) => i.id));
    for (const i of p2.body.items as { id: string }[]) expect(seen.has(i.id)).toBe(false);
  });

  it("rejects unknown query keys and bad cursors length", async () => {
    expect((await call(OPS, "get", `${base}?bogus=1`)).status).toBe(400);
  });

  it("decision due helper counts 5 Cairo business days (Fri/Sat weekend)", () => {
    // Sunday 2026-01-04 10:00 Cairo (08:00Z) + 5 business days = next Sunday 2026-01-11 (Fri/Sat skipped).
    const start = Date.UTC(2026, 0, 4, 8, 0, 0);
    expect(new Date(computeDecisionDueAt(start)).toISOString()).toBe("2026-01-11T08:00:00.000Z");
  });

  it("detail is 404 for an unknown id and carries ETag + masked shape for a known one", async () => {
    expect((await call(OPS, "get", `${base}/${uid(404)}`)).status).toBe(404);
    const a = seed();
    h.verification.setReport(a.id, { checks: [{ code: "domain_verified", result: "pass", detail: null, ranAtMs: h.clock.nowMs() }], dualApprovalRequired: false, riskScore: null });
    const r = await call(OPS, "get", `${base}/${a.id}`);
    expect(r.status).toBe(200);
    expect(r.headers.etag).toBe('"v1"');
    expect(r.body.auto_checks).toHaveLength(1);
    expect(JSON.stringify(r.body)).not.toContain("hash-applicant");
    expect(r.body.application.id).toBe(a.id);
  });
});

describe("claim and release", () => {
  it("claims, is idempotent for the same admin, refuses another admin, releases", async () => {
    const a = seed();
    const c1 = await call(OPS, "post", `${base}/${a.id}/claim`);
    expect(c1.status).toBe(200);
    expect(c1.body.assignee_id).toBe(OPS.actor.id);
    expect((await call(OPS, "post", `${base}/${a.id}/claim`)).status).toBe(200);
    const other = await call(PRINCIPALS.trust_safety, "post", `${base}/${a.id}/claim`);
    expect(other.status).toBe(409);
    expect(other.body.code).toBe("already_claimed");
    const rel = await call(PRINCIPALS.trust_safety, "post", `${base}/${a.id}/release`);
    expect(rel.status).toBe(409);
    expect(rel.body.code).toBe("not_assignee");
    const ok = await call(OPS, "post", `${base}/${a.id}/release`);
    expect(ok.body.assignee_id).toBeNull();
    expect(h.audit.entries.map((e) => e.action)).toEqual(expect.arrayContaining(["brand_application.claimed", "brand_application.released"]));
  });

  it("applicant == reviewer is 409 reviewer_is_applicant (user id, phone hash, brand domain)", async () => {
    const byId = seed({ applicantShopperUserId: OPS.actor.id });
    const r1 = await call(OPS, "post", `${base}/${byId.id}/claim`);
    expect(r1.status).toBe(409);
    expect(r1.body.code).toBe("reviewer-is-applicant".replaceAll("-", "_"));

    h.reviewers.set({ userId: PRINCIPALS.trust_safety.actor.id, phoneHash: "hash-applicant", emailDomain: null });
    const byPhone = seed();
    expect((await call(PRINCIPALS.trust_safety, "post", `${base}/${byPhone.id}/claim`)).body.code).toBe("reviewer_is_applicant");

    h.reviewers.set({ userId: PRINCIPALS.ops2.actor.id, phoneHash: null, emailDomain: "mail.nilebasics.example" });
    const byDomain = seed();
    expect((await call(PRINCIPALS.ops2, "post", `${base}/${byDomain.id}/claim`)).body.code).toBe("reviewer_is_applicant");
    for (const p of [PRINCIPALS.trust_safety, PRINCIPALS.ops2]) h.reviewers.set({ userId: p.actor.id, phoneHash: null, emailDomain: null });
    // decision and read-url refuse the same way even if assigned
    const assigned = seed({ applicantShopperUserId: OPS.actor.id, assigneeId: OPS.actor.id });
    expect((await call(OPS, "post", `${base}/${assigned.id}/decision`, { decision: "approve", reason_code: "ok" })).body.code).toBe("reviewer_is_applicant");
    expect((await call(OPS, "post", `${base}/${assigned.id}/documents/${DOC}/read-url`, { reason_code: "kyc_review" })).body.code).toBe("reviewer_is_applicant");
  });

  it("only IN_REVIEW applications can be claimed", async () => {
    const a = seed({ status: "SUBMITTED" });
    const r = await call(OPS, "post", `${base}/${a.id}/claim`);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("invalid_transition");
  });
});

describe("decision", () => {
  const claimed = () => seed({ assigneeId: OPS.actor.id });

  it("validates: reject needs reason and both messages, needs_info needs an item, approve needs ok", async () => {
    const a = claimed();
    const noReason = await call(OPS, "post", `${base}/${a.id}/decision`, { decision: "reject", reason_code: "ok", public_message_ar: "x", public_message_en: "x" });
    expect(noReason.status).toBe(400);
    const noMsg = await call(OPS, "post", `${base}/${a.id}/decision`, { decision: "reject", reason_code: "ownership_not_proven" });
    expect(noMsg.status).toBe(400);
    const noItems = await call(OPS, "post", `${base}/${a.id}/decision`, {
      decision: "needs_info",
      reason_code: "incomplete_information",
      public_message_ar: "ناقص",
      public_message_en: "missing",
      requested_items: [],
    });
    expect(noItems.status).toBe(400);
    expect((await call(OPS, "post", `${base}/${a.id}/decision`, { decision: "approve", reason_code: "other" })).status).toBe(400);
    expect((await call(OPS, "post", `${base}/${a.id}/decision`, { decision: "approve", reason_code: "ok", extra: 1 })).status).toBe(400);
    expect(h.apps.outbox.filter((e) => (e.payload["application_id"] as string) === a.id)).toHaveLength(0);
  });

  it("must be the assignee", async () => {
    const a = seed({ assigneeId: PRINCIPALS.trust_safety.actor.id });
    const r = await call(OPS, "post", `${base}/${a.id}/decision`, { decision: "approve", reason_code: "ok" });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("not_assignee");
    const un = seed();
    expect((await call(OPS, "post", `${base}/${un.id}/decision`, { decision: "approve", reason_code: "ok" })).body.code).toBe("not_assignee");
  });

  it("rejection emits only brand_application.rejected (never an approved event) and audits with reason", async () => {
    const a = claimed();
    const r = await call(OPS, "post", `${base}/${a.id}/decision`, {
      decision: "reject",
      reason_code: "ownership_not_proven",
      public_message_ar: "لم يثبت الملكية",
      public_message_en: "Ownership not proven",
      internal_note: "docs inconsistent",
    });
    expect(r.status).toBe(200);
    expect(r.body.application.status).toBe("REJECTED");
    expect(r.body.application.decision.reason_code).toBe("ownership_not_proven");
    const events = h.apps.outbox.filter((e) => e.payload["application_id"] === a.id).map((e) => e.type);
    expect(events).toEqual(["brand_application.rejected"]);
    const audit = h.audit.entries.find((e) => e.action === "brand_application.reject");
    expect(audit?.reasonCode).toBe("kyc_review");
    expect(audit?.diff["brand_reason_code"]).toBe("ownership_not_proven");
    expect(JSON.stringify(audit)).not.toContain("docs inconsistent"); // no free text in the audit diff
    // terminal: deciding again is a conflict
    expect((await call(OPS, "post", `${base}/${a.id}/decision`, { decision: "approve", reason_code: "ok" })).status).toBe(409);
  });

  it("needs_info stores the requested items; internal note is not exposed in the applicant fields", async () => {
    const a = claimed();
    const r = await call(OPS, "post", `${base}/${a.id}/decision`, {
      decision: "needs_info",
      reason_code: "incomplete_information",
      public_message_ar: "نرجو إرسال المستند",
      public_message_en: "Please send the document",
      requested_items: [{ code: "tax_card", kind: "document", message_ar: "البطاقة الضريبية", message_en: "Tax card" }],
      internal_note: "tax card blurry",
    });
    expect(r.status).toBe(200);
    expect(r.body.application.status).toBe("NEEDS_INFO");
    expect(r.body.application.requested_items).toHaveLength(1);
    expect(JSON.stringify(r.body.application)).not.toContain("blurry");
  });

  it("approve (not high risk) approves and emits exactly one approved event; replay with the same key is stored", async () => {
    const a = claimed();
    h.verification.setReport(a.id, { checks: [], dualApprovalRequired: false, riskScore: null });
    const key = idemKey();
    const first = await call(OPS, "post", `${base}/${a.id}/decision`, { decision: "approve", reason_code: "ok", slug: "nile-basics" }, key);
    expect(first.status).toBe(200);
    expect(first.body.application.status).toBe("APPROVED");
    const replay = await call(OPS, "post", `${base}/${a.id}/decision`, { decision: "approve", reason_code: "ok", slug: "nile-basics" }, key);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    const diff = await call(OPS, "post", `${base}/${a.id}/decision`, { decision: "reject", reason_code: "other", public_message_ar: "x", public_message_en: "x" }, key);
    expect(diff.status).toBe(422);
    expect(h.apps.outbox.filter((e) => e.payload["application_id"] === a.id && e.type === "brand_application.approved")).toHaveLength(1);
  });

  it("stale If-Match is 409 version_conflict and writes nothing", async () => {
    const a = claimed();
    h.verification.setReport(a.id, { checks: [], dualApprovalRequired: false, riskScore: null });
    const res = await h
      .http()
      .post(`/v1${base}/${a.id}/decision`)
      .set(bearer(OPS))
      .set("Idempotency-Key", idemKey())
      .set("If-Match", '"v99"')
      .send({ decision: "approve", reason_code: "ok" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("version_conflict");
    expect((await h.apps.get(a.id))?.status).toBe("IN_REVIEW");
  });

  it("an open claim conflict blocks approval", async () => {
    const a = seed({ assigneeId: OPS.actor.id, claimConflictOpen: true });
    h.verification.setReport(a.id, { checks: [], dualApprovalRequired: false, riskScore: null });
    const r = await call(OPS, "post", `${base}/${a.id}/decision`, { decision: "approve", reason_code: "ok" });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("claim_conflict_open");
  });

  it("a missing auto-check report fails closed to dual approval", async () => {
    const a = claimed();
    const r = await call(OPS, "post", `${base}/${a.id}/decision`, { decision: "approve", reason_code: "ok" });
    expect(r.status).toBe(200);
    expect(r.body.pending_cosign).toBe(true);
    expect(r.body.application.status).toBe("IN_REVIEW");
  });

  it("an audit failure on a decision is a closed 503", async () => {
    const a = claimed();
    h.verification.setReport(a.id, { checks: [], dualApprovalRequired: false, riskScore: null });
    h.audit.failNext = true;
    const r = await call(OPS, "post", `${base}/${a.id}/decision`, { decision: "approve", reason_code: "ok" });
    expect(r.status).toBe(503);
  });
});

describe("dual approval (GLOBAL high-risk)", () => {
  it("is blocked until a different, elevated admin cosigns", async () => {
    const now = h.clock.nowMs();
    const a = seed({ brandKind: "global", country: "AE", highRiskCountry: true, assigneeId: OPS.actor.id });
    h.verification.setReport(a.id, { checks: [], dualApprovalRequired: true, riskScore: null });

    const first = await call(OPS, "post", `${base}/${a.id}/decision`, { decision: "approve", reason_code: "ok" });
    expect(first.status).toBe(200);
    expect(first.body.application.status).toBe("IN_REVIEW");
    expect(first.body.pending_cosign).toBe(true);
    expect(h.apps.outbox.some((e) => e.payload["application_id"] === a.id && e.type === "brand_application.approved")).toBe(false);
    // approving again does not skip the cosign
    expect((await call(OPS, "post", `${base}/${a.id}/decision`, { decision: "approve", reason_code: "ok" })).body.code).toBe("cosign_required");

    // not elevated: standing ops2 cannot cosign
    const noElev = await call(PRINCIPALS.ops2, "post", `${base}/${a.id}/cosign`, { internal_note: "ok" });
    expect(noElev.status).toBe(403);
    expect(noElev.body.code).toBe("elevation_required");

    // same admin (elevated into trust_safety) is refused
    h.adminStore.elevate(OPS.actor.id, "trust_safety", now);
    const same = await call(OPS, "post", `${base}/${a.id}/cosign`, { internal_note: "me again" });
    expect(same.status).toBe(409);
    expect(same.body.code).toBe("cosign_same_admin");

    // a different admin with a live elevation completes it
    h.adminStore.elevate(PRINCIPALS.ops2.actor.id, "trust_safety", h.clock.nowMs());
    const done = await call(PRINCIPALS.ops2, "post", `${base}/${a.id}/cosign`, { internal_note: "second approver" });
    expect(done.status).toBe(200);
    expect(done.body.application.status).toBe("APPROVED");
    expect(h.apps.outbox.filter((e) => e.payload["application_id"] === a.id && e.type === "brand_application.approved")).toHaveLength(1);
    const act = h.audit.entries.find((e) => e.action === "brand_application.approve");
    expect(act?.diff["cosigned"]).toBe(true);
  });

  it("cosign without a pending request is 409, an expired request is 409", async () => {
    const a = seed({ assigneeId: OPS.actor.id });
    h.adminStore.elevate(PRINCIPALS.ops2.actor.id, "trust_safety", h.clock.nowMs());
    expect((await call(PRINCIPALS.ops2, "post", `${base}/${a.id}/cosign`, { internal_note: "x" })).body.code).toBe("cosign_not_requested");
    const e = seed({ pendingCosign: { firstApproverId: OPS.actor.id, requestedAtMs: h.clock.nowMs() - 25 * 3_600_000 } });
    h.adminStore.elevate(PRINCIPALS.ops2.actor.id, "trust_safety", h.clock.nowMs());
    expect((await call(PRINCIPALS.ops2, "post", `${base}/${e.id}/cosign`, { internal_note: "x" })).body.code).toBe("cosign_expired");
  });

  it("the cosigner may not be the applicant", async () => {
    const a = seed({ pendingCosign: { firstApproverId: OPS.actor.id, requestedAtMs: h.clock.nowMs() }, applicantShopperUserId: PRINCIPALS.ops2.actor.id });
    h.adminStore.elevate(PRINCIPALS.ops2.actor.id, "trust_safety", h.clock.nowMs());
    expect((await call(PRINCIPALS.ops2, "post", `${base}/${a.id}/cosign`, { internal_note: "x" })).body.code).toBe("reviewer_is_applicant");
  });
});

describe("document read URL", () => {
  const withDoc = (scan: "clean" | "infected" | "pending" = "clean") => {
    const a = seed({ assigneeId: OPS.actor.id });
    const documentId = uid(Math.floor(Math.random() * 1e6) + 10_000);
    h.verification.addDocument(a.id, { id: documentId, requirementCode: "commercial_register", contentType: "application/pdf", sizeBytes: 100, scanStatus: scan, uploadStatus: "uploaded" });
    return { a, documentId };
  };

  it("writes the audit row first, then returns a url that expires within 15 minutes", async () => {
    const { a, documentId } = withDoc();
    const res = await call(OPS, "post", `${base}/${a.id}/documents/${documentId}/read-url`, { reason_code: "kyc_review" });
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toContain("no-store");
    expect(new Date(res.body.expires_at).getTime() - h.clock.nowMs()).toBeLessThanOrEqual(15 * 60_000);
    const e = h.audit.entries.find((x) => x.action === "brand_document.read_url_requested");
    expect(e).toMatchObject({ reasonCode: "kyc_review", targetId: documentId, actorId: OPS.actor.id });
    expect(JSON.stringify(e)).not.toContain("signed"); // the url is never logged
  });

  it("fails closed when the audit append fails: no url minted", async () => {
    const { a, documentId } = withDoc();
    const before = h.verification.minted.length;
    h.audit.failNext = true;
    const res = await call(OPS, "post", `${base}/${a.id}/documents/${documentId}/read-url`, { reason_code: "kyc_review" });
    expect(res.status).toBe(503);
    expect(res.text).not.toContain("https://");
    expect(h.verification.minted.length).toBe(before);
  });

  it("requires a valid reason code, the assignee, a known document and a clean scan", async () => {
    const { a, documentId } = withDoc();
    const url = `${base}/${a.id}/documents/${documentId}/read-url`;
    expect((await call(OPS, "post", url, {})).status).toBe(400);
    expect((await call(OPS, "post", url, { reason_code: "curiosity" })).status).toBe(400);
    expect((await call(PRINCIPALS.trust_safety, "post", url, { reason_code: "kyc_review" })).body.code).toBe("not_assignee");
    expect((await call(OPS, "post", `${base}/${a.id}/documents/${uid(31337)}/read-url`, { reason_code: "kyc_review" })).status).toBe(404);
    const infected = withDoc("infected");
    const r = await call(OPS, "post", `${base}/${infected.a.id}/documents/${infected.documentId}/read-url`, { reason_code: "kyc_review" });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("document_not_readable");
  });

  it("refuses a url that outlives the 15 minute cap", async () => {
    const { a, documentId } = withDoc();
    h.verification.grantTtlMs = 60 * 60_000;
    const res = await call(OPS, "post", `${base}/${a.id}/documents/${documentId}/read-url`, { reason_code: "kyc_review" });
    h.verification.grantTtlMs = null;
    expect(res.status).toBe(503);
    expect(res.text).not.toContain("https://");
  });
});

describe("applicant cannot be a reviewer via the applicant id", () => {
  it("applicant user id equal to the admin id is refused", async () => {
    const a = seed({ applicantUserId: OPS.actor.id });
    expect((await call(OPS, "post", `${base}/${a.id}/claim`)).body.code).toBe("reviewer_is_applicant");
    expect(APPLICANT).not.toBe(OPS.actor.id);
  });
});

describe("retry provisioning", () => {
  const parked = (over: Parameters<typeof makeApplication>[1] = {}) =>
    seed({ status: "PROVISIONING_FAILED", provisioningFailure: "provisioning_error", ...over });

  it("retries a parked application, audits first, and returns the recovered record", async () => {
    const a = parked();
    h.provisioning.outcome = { kind: "provisioned" };
    h.provisioning.calls.length = 0;
    const res = await call(OPS, "post", `${base}/${a.id}/retry-provisioning`);
    expect(res.status).toBe(200);
    expect(res.body.application.status).toBe("APPROVED");
    expect(res.body.application.store_id).not.toBeNull();
    expect(res.body.provisioning_failure).toBeUndefined();
    expect(h.provisioning.calls).toEqual([a.id]);
    expect(h.audit.entries.map((e) => e.action)).toContain("brand_application.provisioning_retry_requested");
  });

  it("a retry that fails again stays parked with the failure visible (200)", async () => {
    const a = parked();
    h.provisioning.outcome = { kind: "provisioning_failed", code: "provisioning_error" };
    const res = await call(OPS, "post", `${base}/${a.id}/retry-provisioning`);
    expect(res.status).toBe(200);
    expect(res.body.application.status).toBe("PROVISIONING_FAILED");
    expect(res.body.provisioning_failure).toBe("provisioning_error");
  });

  it("only PROVISIONING_FAILED is retryable (409) and an unknown id is 404", async () => {
    h.provisioning.calls.length = 0;
    const a = seed({ status: "APPROVED" });
    const r = await call(OPS, "post", `${base}/${a.id}/retry-provisioning`);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("invalid_transition");
    expect(h.provisioning.calls).toEqual([]);
    expect((await call(OPS, "post", `${base}/${uid(424242)}/retry-provisioning`)).status).toBe(404);
  });

  it("the applicant cannot retry their own application", async () => {
    const a = parked({ applicantUserId: OPS.actor.id });
    expect((await call(OPS, "post", `${base}/${a.id}/retry-provisioning`)).body.code).toBe("reviewer_is_applicant");
  });

  it("is listed under the PROVISIONING_FAILED status filter", async () => {
    const a = parked();
    const res = await call(OPS, "get", `${base}?status=PROVISIONING_FAILED`);
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { id: string }) => i.id)).toContain(a.id);
  });
});
