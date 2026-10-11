import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  PRINCIPALS,
  ROLE_PRINCIPALS,
  bearer,
  createAdminHarness,
  idemKey,
  uid,
  type AdminHarness,
  type TestPrincipal,
} from "./test/harness";
import { ADMIN_ROLE_NAMES, type AdminRoleName } from "./domain/bridge";

let h: AdminHarness;
const SELLER = uid(500);
const SUBJECT = uid(600);

beforeAll(async () => {
  h = await createAdminHarness();
}, 60_000);
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  h.clock.advance(61_000); // fresh rate-limit windows
});

type Method = "get" | "post" | "put";
const call = (p: TestPrincipal | null, method: Method, path: string, body?: unknown, idem = method !== "get") => {
  let r = h.http()[method](`/v1${path}`);
  if (p !== null) r = r.set(bearer(p));
  if (idem) r = r.set("Idempotency-Key", idemKey());
  return body === undefined ? r : r.send(body as object);
};

const seedSeller = (id: string, state: "APPROVED" | "DRAFT" | "SUSPENDED" = "APPROVED") =>
  h.kyc.seed({ sellerId: id, state, storeCount: 1, storeNames: ["متجر"], updatedAtMs: h.clock.nowMs() });

describe("negative authorization matrix (every route x every admin sub-role)", () => {
  // Allowed roles are written out by hand here, independent of ROUTE_ROLES, so a wrong edit in the
  // module's table fails this test instead of silently widening access.
  const ALL: AdminRoleName[] = ["ops", "finance", "trust_safety", "support", "marketing", "dpo", "security"];
  interface Route {
    readonly name: string;
    readonly method: Method;
    readonly path: () => string;
    readonly body?: () => unknown;
    readonly allowed: readonly AdminRoleName[];
  }
  const routes: Route[] = [
    { name: "GET approvals", method: "get", path: () => "/admin/approvals", allowed: ALL },
    {
      name: "POST approvals",
      method: "post",
      path: () => "/admin/approvals",
      body: () => ({ kind: "plan_price_change", subject_type: "plan", subject_id: "p1", reason_code: "finance_reconciliation" }),
      allowed: ALL, // the gate admits every admin; requester role per kind is checked below
    },
    { name: "GET elevations/mine", method: "get", path: () => "/admin/elevations/mine", allowed: ALL },
    { name: "GET elevations", method: "get", path: () => "/admin/elevations", allowed: ["security"] },
    {
      name: "POST pii-views",
      method: "post",
      path: () => "/admin/pii-views",
      body: () => ({ subject_user_id: SUBJECT, fields: ["phone"], reason_code: "customer_support_ticket" }),
      allowed: ["support", "trust_safety", "dpo"],
    },
    { name: "GET flags", method: "get", path: () => "/admin/flags", allowed: ["ops", "security"] },
    { name: "GET kill-switches", method: "get", path: () => "/admin/kill-switches", allowed: ["ops", "security"] },
    { name: "GET flags/:key", method: "get", path: () => "/admin/flags/kill.drops", allowed: ["ops", "security"] },
    {
      name: "PUT flags/:key",
      method: "put",
      path: () => "/admin/flags/kill.drops",
      body: () => ({ enabled: true, reason_code: "incident_response" }),
      allowed: ["ops"],
    },
    { name: "GET kyc/queue", method: "get", path: () => "/admin/kyc/queue", allowed: ["ops", "trust_safety", "support"] },
    { name: "GET kyc/sellers/:id", method: "get", path: () => `/admin/kyc/sellers/${SELLER}`, allowed: ["ops", "trust_safety", "support"] },
    {
      name: "POST kyc suspend",
      method: "post",
      path: () => `/admin/kyc/sellers/${uid(777)}/suspend`,
      body: () => ({ reason_code: "fraud_investigation" }),
      allowed: ["ops", "trust_safety"],
    },
    {
      name: "POST kyc reinstate",
      method: "post",
      path: () => `/admin/kyc/sellers/${uid(777)}/reinstate`,
      body: () => ({ reason_code: "kyc_review" }),
      allowed: ["ops", "trust_safety"],
    },
    { name: "GET suspension-reviews", method: "get", path: () => "/admin/kyc/suspension-reviews", allowed: ["ops", "trust_safety", "security"] },
    {
      name: "POST uphold",
      method: "post",
      path: () => `/admin/kyc/suspension-reviews/${uid(778)}/uphold`,
      body: () => ({}),
      allowed: ["ops", "trust_safety"],
    },
  ];

  for (const route of routes) {
    for (const roleName of ALL) {
      const allowed = route.allowed.includes(roleName);
      it(`${route.name} as ${roleName}: ${allowed ? "passes the gate" : "403"}`, async () => {
        const res = await call(ROLE_PRINCIPALS[roleName], route.method, route.path(), route.body?.());
        if (allowed) expect(["missing_role", "passkey_required"]).not.toContain(res.body.code);
        else {
          expect(res.status).toBe(403);
          expect(res.body.code).toBe("missing_role");
        }
        expect(res.status).not.toBe(401);
      });
    }
    it(`${route.name}: standing super_admin without break-glass is 403 (or gate-only for any-admin routes)`, async () => {
      const res = await call(ROLE_PRINCIPALS.super_admin, route.method, route.path(), route.body?.());
      if (route.allowed.length === ALL.length) expect(res.body.code).not.toBe("missing_role");
      else {
        expect(res.status).toBe(403);
        expect(res.body.code).toBe("missing_role");
      }
    });
    it(`${route.name}: no token 401, shopper audience 401, no grants 403, no passkey 403, expired grant 403`, async () => {
      expect((await call(null, route.method, route.path(), route.body?.())).status).toBe(401);
      expect((await call(PRINCIPALS.shopperOnBuyerAud, route.method, route.path(), route.body?.())).status).toBe(401);
      expect((await call(PRINCIPALS.noGrants, route.method, route.path(), route.body?.())).status).toBe(403);
      expect((await call(PRINCIPALS.opsNoPasskey, route.method, route.path(), route.body?.())).status).toBe(403);
      expect((await call(PRINCIPALS.opsExpired, route.method, route.path(), route.body?.())).status).toBe(403);
    });
  }

  const idRoutes: { name: string; method: Method; path: string; body?: unknown }[] = [
    { name: "GET approvals/:id", method: "get", path: `/admin/approvals/${uid(900)}` },
    { name: "POST approve", method: "post", path: `/admin/approvals/${uid(900)}/approve`, body: {} },
    { name: "POST reject", method: "post", path: `/admin/approvals/${uid(900)}/reject`, body: {} },
    { name: "POST elevation activate", method: "post", path: `/admin/elevations/${uid(901)}/activate`, body: {} },
    { name: "POST elevation revoke", method: "post", path: `/admin/elevations/${uid(901)}/revoke`, body: {} },
  ];
  for (const r of idRoutes) {
    it(`${r.name}: unknown object is 404 for an admin, 403/401 for everyone else`, async () => {
      expect((await call(PRINCIPALS.finance, r.method, r.path, r.body)).status).toBe(404);
      expect((await call(PRINCIPALS.noGrants, r.method, r.path, r.body)).status).toBe(403);
      expect((await call(PRINCIPALS.opsNoPasskey, r.method, r.path, r.body)).status).toBe(403);
      expect((await call(null, r.method, r.path, r.body)).status).toBe(401);
      expect((await call(PRINCIPALS.shopperOnBuyerAud, r.method, r.path, r.body)).status).toBe(401);
    });
  }

  it("denied decisions are written to the platform audit sink", () => {
    expect(h.sink.entries.some((e) => e.effect === "deny" && e.reason === "missing_role")).toBe(true);
    expect(h.sink.entries.some((e) => e.effect === "deny" && e.reason === "passkey_required")).toBe(true);
  });
});

describe("dual approval", () => {
  it("requester can never approve; scope required; distinct finance approver succeeds once", async () => {
    const created = await call(PRINCIPALS.finance, "post", "/admin/approvals", {
      kind: "plan_price_change",
      subject_type: "plan",
      subject_id: "plus-yearly",
      reason_code: "finance_reconciliation",
    });
    expect(created.status).toBe(201);
    expect(created.body.state).toBe("REQUESTED");
    const id = created.body.id as string;

    expect((await call(PRINCIPALS.finance, "post", `/admin/approvals/${id}/approve`, {})).status).toBe(403);
    // marketing cannot even see it (404), ops likewise
    expect((await call(PRINCIPALS.marketing, "post", `/admin/approvals/${id}/approve`, {})).status).toBe(404);
    expect((await call(PRINCIPALS.ops, "get", `/admin/approvals/${id}`)).status).toBe(404);

    const ok = await call(PRINCIPALS.finance2, "post", `/admin/approvals/${id}/approve`, { note: "checked" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ state: "APPROVED", approver_id: PRINCIPALS.finance2.actor.id });
    expect((await call(PRINCIPALS.finance2, "post", `/admin/approvals/${id}/approve`, {})).status).toBe(409);
    expect((await call(PRINCIPALS.finance2, "post", `/admin/approvals/${id}/reject`, {})).status).toBe(409);

    const entry = h.audit.entries.find((e) => e.action === "approval.approved" && e.targetId === id);
    expect(entry).toMatchObject({ actorId: PRINCIPALS.finance2.actor.id, reasonCode: "finance_reconciliation" });
  });

  it("requester role per kind is enforced (marketing cannot request a payout)", async () => {
    const r = await call(PRINCIPALS.marketing, "post", "/admin/approvals", {
      kind: "payout",
      subject_type: "payout",
      subject_id: "po-1",
      amount_minor: "9000000",
      reason_code: "finance_reconciliation",
    });
    expect(r.status).toBe(403);
  });

  it("refund threshold: below needs no approval record, at or above does", async () => {
    const small = await call(PRINCIPALS.finance, "post", "/admin/approvals", {
      kind: "refund",
      subject_type: "refund",
      subject_id: "r-small",
      amount_minor: "499999",
      reason_code: "customer_support_ticket",
    });
    expect(small.status).toBe(201);
    expect(small.body).toEqual({ approval_required: false });
    const big = await call(PRINCIPALS.finance, "post", "/admin/approvals", {
      kind: "refund",
      subject_type: "refund",
      subject_id: "r-big",
      amount_minor: "500000",
      reason_code: "customer_support_ticket",
    });
    expect(big.status).toBe(201);
    expect(big.body).toMatchObject({ kind: "refund", amount_minor: "500000", state: "REQUESTED" });
  });

  it("elevation kinds cannot be requested through the generic endpoint", async () => {
    const r = await call(PRINCIPALS.super_admin, "post", "/admin/approvals", {
      kind: "break_glass",
      subject_type: "elevation",
      subject_id: "x",
      reason_code: "break_glass_emergency",
    });
    expect(r.status).toBe(403);
  });

  it("validates the body: reason codes are an enum, extra fields are rejected", async () => {
    const bad = await call(PRINCIPALS.finance, "post", "/admin/approvals", {
      kind: "plan_price_change",
      subject_type: "plan",
      subject_id: "p",
      reason_code: "because",
    });
    expect(bad.status).toBe(400);
    const extra = await call(PRINCIPALS.finance, "post", "/admin/approvals", {
      kind: "plan_price_change",
      subject_type: "plan",
      subject_id: "p",
      reason_code: "kyc_review",
      requester_id: uid(1),
    });
    expect(extra.status).toBe(400);
  });

  it("an approval that outlives its window is EXPIRED and cannot be approved", async () => {
    const created = await call(PRINCIPALS.finance, "post", "/admin/approvals", {
      kind: "plan_price_change",
      subject_type: "plan",
      subject_id: "plus-monthly",
      reason_code: "finance_reconciliation",
    });
    h.clock.advance(25 * 3_600_000);
    const r = await call(PRINCIPALS.finance2, "post", `/admin/approvals/${created.body.id}/approve`, {});
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("approval_expired");
    const after = await call(PRINCIPALS.finance2, "get", `/admin/approvals/${created.body.id}`);
    expect(after.body.state).toBe("EXPIRED");
  });

  it("list shows only what the caller may see", async () => {
    const mine = await call(PRINCIPALS.finance, "get", "/admin/approvals?mine=true&limit=200");
    expect(mine.status).toBe(200);
    for (const a of mine.body.items) expect(a.requester_id).toBe(PRINCIPALS.finance.actor.id);
    const marketing = await call(PRINCIPALS.marketing, "get", "/admin/approvals?limit=200");
    expect(marketing.body.items).toEqual([]);
  });
});

describe("just-in-time elevation and break-glass", () => {
  it("ops elevated to finance for 30 minutes, security approves, overlay lapses on time", async () => {
    // a refund approval that only finance (or super_admin) may see
    const refund = await call(PRINCIPALS.finance, "post", "/admin/approvals", {
      kind: "refund",
      subject_type: "refund",
      subject_id: "r-elev",
      amount_minor: "800000",
      reason_code: "customer_support_ticket",
    });
    const refundId = refund.body.id as string;
    expect((await call(PRINCIPALS.ops2, "post", `/admin/approvals/${refundId}/approve`, {})).status).toBe(404);

    const bad = await call(PRINCIPALS.ops2, "post", "/admin/elevations", { role: "finance", reason_code: "nope" });
    expect(bad.status).toBe(400);
    const tooLong = await call(PRINCIPALS.ops2, "post", "/admin/elevations", {
      role: "finance",
      reason_code: "finance_reconciliation",
      ttl_minutes: 240,
    });
    expect(tooLong.status).toBe(201); // 240 is the cap
    const req = await call(PRINCIPALS.ops2, "post", "/admin/elevations", {
      role: "finance",
      reason_code: "finance_reconciliation",
      ttl_minutes: 30,
    });
    expect(req.status).toBe(201);
    const elevId = req.body.elevation.id as string;
    const approvalId = req.body.approval.id as string;
    expect(req.body.elevation.state).toBe("PENDING_APPROVAL");

    // not active yet, activation without approval is refused, others get 404
    expect((await call(PRINCIPALS.ops2, "post", `/admin/elevations/${elevId}/activate`, {})).status).toBe(403);
    expect((await call(PRINCIPALS.ops, "post", `/admin/elevations/${elevId}/activate`, {})).status).toBe(404);
    // requester cannot approve; ops/finance cannot (no scope); security can
    expect((await call(PRINCIPALS.ops2, "post", `/admin/approvals/${approvalId}/approve`, {})).status).toBe(403);
    expect((await call(PRINCIPALS.finance, "post", `/admin/approvals/${approvalId}/approve`, {})).status).toBe(404);
    expect((await call(PRINCIPALS.security, "post", `/admin/approvals/${approvalId}/approve`, {})).status).toBe(200);

    const act = await call(PRINCIPALS.ops2, "post", `/admin/elevations/${elevId}/activate`, {});
    expect(act.status).toBe(200);
    expect(act.body.state).toBe("ACTIVE");
    expect(Date.parse(act.body.expires_at) - h.clock.nowMs()).toBe(30 * 60_000);
    expect(h.audit.entries.find((e) => e.action === "elevation.activated")).toMatchObject({ reasonCode: "finance_reconciliation" });

    // now ops2 acts with the finance role
    expect((await call(PRINCIPALS.ops2, "post", `/admin/approvals/${refundId}/approve`, { note: "elevated" })).status).toBe(200);

    // a second refund after the window closes is invisible again
    const refund2 = await call(PRINCIPALS.finance, "post", "/admin/approvals", {
      kind: "refund",
      subject_type: "refund",
      subject_id: "r-elev-2",
      amount_minor: "800000",
      reason_code: "customer_support_ticket",
    });
    h.clock.advance(30 * 60_000);
    expect((await call(PRINCIPALS.ops2, "post", `/admin/approvals/${refund2.body.id}/approve`, {})).status).toBe(404);
  });

  it("only security or break-glass super_admin lists and revokes others' elevations", async () => {
    const req = await call(PRINCIPALS.support, "post", "/admin/elevations", { role: "dpo", reason_code: "dsar_fulfilment" });
    const approval = req.body.approval.id as string;
    await call(PRINCIPALS.security2, "post", `/admin/approvals/${approval}/approve`, {});
    await call(PRINCIPALS.support, "post", `/admin/elevations/${req.body.elevation.id}/activate`, {});
    const list = await call(PRINCIPALS.security, "get", "/admin/elevations");
    expect(list.body.items.some((e: { id: string }) => e.id === req.body.elevation.id)).toBe(true);
    expect((await call(PRINCIPALS.ops, "post", `/admin/elevations/${req.body.elevation.id}/revoke`, {})).status).toBe(404);
    const rev = await call(PRINCIPALS.security, "post", `/admin/elevations/${req.body.elevation.id}/revoke`, {});
    expect(rev.status).toBe(200);
    expect(rev.body.state).toBe("REVOKED");
    expect((await call(PRINCIPALS.security, "post", `/admin/elevations/${req.body.elevation.id}/revoke`, {})).status).toBe(403);
  });

  it("break-glass: super_admin needs another person's approval and then only 30 minutes", async () => {
    // standing grant alone opens nothing
    expect((await call(PRINCIPALS.super_admin, "get", "/admin/flags")).status).toBe(403);
    // non super_admin cannot open break-glass
    const nope = await call(PRINCIPALS.ops, "post", "/admin/elevations", { role: "super_admin", reason_code: "break_glass_emergency" });
    expect(nope.status).toBe(400);
    const tooLong = await call(PRINCIPALS.super_admin, "post", "/admin/elevations", {
      role: "super_admin",
      reason_code: "break_glass_emergency",
      ttl_minutes: 31,
    });
    expect(tooLong.status).toBe(400);

    const req = await call(PRINCIPALS.super_admin, "post", "/admin/elevations", {
      role: "super_admin",
      reason_code: "break_glass_emergency",
    });
    expect(req.status).toBe(201);
    expect(req.body.approval.kind).toBe("break_glass");
    const approvalId = req.body.approval.id as string;
    const elevId = req.body.elevation.id as string;
    // self approval and activation before approval are refused
    expect((await call(PRINCIPALS.super_admin, "post", `/admin/approvals/${approvalId}/approve`, {})).status).toBe(403);
    expect((await call(PRINCIPALS.super_admin, "post", `/admin/elevations/${elevId}/activate`, {})).status).toBe(403);
    // another super_admin without a live break-glass sees nothing: 404
    expect((await call(PRINCIPALS.super_admin2, "post", `/admin/approvals/${approvalId}/approve`, {})).status).toBe(404);
    expect((await call(PRINCIPALS.security, "post", `/admin/approvals/${approvalId}/approve`, {})).status).toBe(200);
    expect((await call(PRINCIPALS.super_admin, "post", `/admin/elevations/${elevId}/activate`, {})).status).toBe(200);

    expect((await call(PRINCIPALS.super_admin, "get", "/admin/flags")).status).toBe(200);
    expect(h.audit.entries.some((e) => e.action === "break_glass.activated")).toBe(true);
    h.clock.advance(30 * 60_000);
    expect((await call(PRINCIPALS.super_admin, "get", "/admin/flags")).status).toBe(403);
  });
});

describe("PII views", () => {
  beforeAll(() => {
    h.pii.seed(SUBJECT, { phone: "+201001234567", email: "x@example.test", display_name: "Mona" });
  });

  it("logs the reason code before returning only the requested fields", async () => {
    const before = h.audit.entries.length;
    const r = await call(PRINCIPALS.support, "post", "/admin/pii-views", {
      subject_user_id: SUBJECT,
      fields: ["phone"],
      reason_code: "customer_support_ticket",
    });
    expect(r.status).toBe(200);
    expect(r.body.fields).toEqual({ phone: "+201001234567" });
    const row = h.audit.entries.slice(before).find((e) => e.action === "pii_view.read");
    expect(row).toMatchObject({
      actorId: PRINCIPALS.support.actor.id,
      targetType: "user",
      targetId: SUBJECT,
      reasonCode: "customer_support_ticket",
    });
    expect(JSON.stringify(row)).not.toContain("+2010012");
  });

  it("requires a valid reason code", async () => {
    const r = await call(PRINCIPALS.support, "post", "/admin/pii-views", { subject_user_id: SUBJECT, fields: ["phone"] });
    expect(r.status).toBe(400);
    const r2 = await call(PRINCIPALS.support, "post", "/admin/pii-views", {
      subject_user_id: SUBJECT,
      fields: ["phone"],
      reason_code: "curious",
    });
    expect(r2.status).toBe(400);
  });

  it("unknown subject is 404 and the attempt is still logged", async () => {
    const before = h.audit.entries.length;
    const r = await call(PRINCIPALS.support, "post", "/admin/pii-views", {
      subject_user_id: uid(12345),
      fields: ["email"],
      reason_code: "kyc_review",
    });
    expect(r.status).toBe(404);
    expect(h.audit.entries.length).toBe(before + 1);
  });

  it("fails closed when the audit chain cannot be written: 503 and no data", async () => {
    h.audit.failNext = true;
    const r = await call(PRINCIPALS.dpo, "post", "/admin/pii-views", {
      subject_user_id: SUBJECT,
      fields: ["phone"],
      reason_code: "dsar_fulfilment",
    });
    expect(r.status).toBe(503);
    expect(JSON.stringify(r.body)).not.toContain("+2010012");
  });
});

describe("feature flags and kill switches", () => {
  it("lists the 14 kill switches of spec A2.12, all off by default", async () => {
    const r = await call(PRINCIPALS.ops, "get", "/admin/kill-switches");
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(14);
    const keys = r.body.items.map((i: { key: string }) => i.key);
    for (const k of ["kill.payment.card", "kill.payment.cod", "kill.payment.bnpl", "kill.drops", "kill.games", "kill.stylist_llm", "kill.ml_ranking", "kill.crawlers", "kill.referral_payouts", "kill.gift_card_sales"]) {
      expect(keys).toContain(k);
    }
    expect(r.body.items.every((i: { kind: string }) => i.kind === "kill_switch")).toBe(true);
  });

  it("changing a flag is audited with before/after and reason", async () => {
    const r = await call(PRINCIPALS.ops, "put", "/admin/flags/kill.payment.cod", { enabled: true, reason_code: "incident_response" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ key: "kill.payment.cod", enabled: true, previous_enabled: false, is_default: false });
    expect(h.audit.entries.find((e) => e.action === "kill_switch.changed" && e.diff["key"] === "kill.payment.cod")).toMatchObject({
      actorId: PRINCIPALS.ops.actor.id,
      reasonCode: "incident_response",
      diff: { key: "kill.payment.cod", from: false, to: true },
    });
    expect((await call(PRINCIPALS.security, "get", "/admin/flags/kill.payment.cod")).body.enabled).toBe(true);
  });

  it("unknown key is 404, bad key shape 400, missing reason 400, audit failure blocks the change", async () => {
    expect((await call(PRINCIPALS.ops, "put", "/admin/flags/kill.unknown", { enabled: true, reason_code: "incident_response" })).status).toBe(404);
    expect((await call(PRINCIPALS.ops, "put", "/admin/flags/Bad..Key", { enabled: true, reason_code: "incident_response" })).status).toBe(400);
    expect((await call(PRINCIPALS.ops, "put", "/admin/flags/kill.games", { enabled: true })).status).toBe(400);
    h.audit.failNext = true;
    expect((await call(PRINCIPALS.ops, "put", "/admin/flags/kill.games", { enabled: true, reason_code: "incident_response" })).status).toBe(503);
    expect((await call(PRINCIPALS.ops, "get", "/admin/flags/kill.games")).body.enabled).toBe(false);
  });

  it("filters by kind", async () => {
    const r = await call(PRINCIPALS.ops, "get", "/admin/flags?kind=release");
    expect(r.body.items.map((i: { key: string }) => i.key)).toEqual(["release.us_storefront_linkout"]);
  });
});

describe("seller KYC queue, suspension and the 5 business day review", () => {
  const S1 = uid(501);
  const S2 = uid(502);
  const S3 = uid(503);
  beforeAll(() => {
    seedSeller(S1, "APPROVED");
    seedSeller(S2, "DRAFT");
    seedSeller(S3, "APPROVED");
  });

  it("queue is filterable and readable by support", async () => {
    const all = await call(PRINCIPALS.support, "get", "/admin/kyc/queue");
    expect(all.status).toBe(200);
    expect(all.body.items.length).toBeGreaterThanOrEqual(3);
    const drafts = await call(PRINCIPALS.support, "get", "/admin/kyc/queue?state=DRAFT");
    expect(drafts.body.items.every((i: { kyc_state: string }) => i.kyc_state === "DRAFT")).toBe(true);
    expect((await call(PRINCIPALS.support, "get", `/admin/kyc/sellers/${uid(9999)}`)).status).toBe(404);
  });

  it("suspend drives the KYC machine, opens a review due in 5 business days, and a different human decides", async () => {
    const s = await call(PRINCIPALS.trust_safety, "post", `/admin/kyc/sellers/${S1}/suspend`, { reason_code: "fraud_investigation" });
    expect(s.status).toBe(200);
    expect(s.body.kyc_state).toBe("SUSPENDED");
    expect(s.body.review).toMatchObject({ state: "OPEN", overdue: false, automatic: false });
    const due = Date.parse(s.body.review.due_at);
    const days = Math.round((due - h.clock.nowMs()) / 86_400_000);
    expect(days).toBeGreaterThanOrEqual(5);
    expect(days).toBeLessThanOrEqual(7);
    // suspending twice is an invalid transition
    expect((await call(PRINCIPALS.trust_safety, "post", `/admin/kyc/sellers/${S1}/suspend`, { reason_code: "fraud_investigation" })).status).toBe(409);
    // the suspender cannot reinstate their own suspension
    expect((await call(PRINCIPALS.trust_safety, "post", `/admin/kyc/sellers/${S1}/reinstate`, { reason_code: "kyc_review" })).status).toBe(403);
    // overdue flag appears after the SLA lapses
    h.clock.advance(8 * 86_400_000);
    const reviews = await call(PRINCIPALS.security, "get", "/admin/kyc/suspension-reviews?state=OPEN");
    expect(reviews.body.items.find((r: { seller_id: string }) => r.seller_id === S1).overdue).toBe(true);
    const back = await call(PRINCIPALS.ops, "post", `/admin/kyc/sellers/${S1}/reinstate`, { reason_code: "kyc_review" });
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ kyc_state: "APPROVED", review: { state: "REINSTATED" } });
    expect(h.audit.entries.find((e) => e.action === "kyc.reinstated")).toMatchObject({ actorId: PRINCIPALS.ops.actor.id, reasonCode: "kyc_review" });
  });

  it("uphold closes the review and keeps the seller suspended; not-suspended seller cannot be reinstated", async () => {
    const s = await call(PRINCIPALS.ops, "post", `/admin/kyc/sellers/${S3}/suspend`, { reason_code: "legal_request" });
    const reviewId = s.body.review.id as string;
    expect((await call(PRINCIPALS.ops, "post", `/admin/kyc/suspension-reviews/${reviewId}/uphold`, {})).status).toBe(403);
    const up = await call(PRINCIPALS.trust_safety2, "post", `/admin/kyc/suspension-reviews/${reviewId}/uphold`, {});
    expect(up.status).toBe(200);
    expect(up.body.state).toBe("UPHELD");
    expect((await call(PRINCIPALS.trust_safety2, "post", `/admin/kyc/suspension-reviews/${reviewId}/uphold`, {})).status).toBe(403);
    expect((await call(PRINCIPALS.trust_safety, "get", `/admin/kyc/sellers/${S3}`)).body.kyc_state).toBe("SUSPENDED");
    expect((await call(PRINCIPALS.trust_safety, "post", `/admin/kyc/sellers/${S2}/reinstate`, { reason_code: "kyc_review" })).status).toBe(409);
    expect((await call(PRINCIPALS.trust_safety, "post", `/admin/kyc/sellers/${S2}/suspend`, { reason_code: "kyc_review" })).status).toBe(409);
    expect((await call(PRINCIPALS.trust_safety, "post", `/admin/kyc/sellers/${uid(8888)}/suspend`, { reason_code: "kyc_review" })).status).toBe(404);
  });
});

describe("registry sanity", () => {
  it("every admin role has a principal", () => {
    for (const r of ADMIN_ROLE_NAMES) expect(ROLE_PRINCIPALS[r]).toBeDefined();
  });
});
