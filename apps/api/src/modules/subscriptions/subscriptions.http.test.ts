import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DAY, TOKENS, USERS, bearer, createPlusHarness, idem, type PlusHarness } from "./test/http-harness";

let h: PlusHarness;
beforeAll(async () => {
  h = await createPlusHarness();
}, 60_000);
afterAll(async () => {
  await h.close();
});

/** Fresh rate-limit window for each call site (the longest window is 10 minutes). */
const tick = (): void => h.clock.advance(601_000);
const post = (path: string, token: string | null, body: unknown = {}, extra: Record<string, string> = idem()) => {
  tick();
  const r = h.http().post(path).set(extra);
  return (token === null ? r : r.set(bearer(token))).send(body as object);
};
const get = (path: string, token: string | null = null) => {
  tick();
  const r = h.http().get(path);
  return token === null ? r : r.set(bearer(token));
};
const patch = (path: string, token: string, body: unknown) => {
  tick();
  return h.http().patch(path).set(idem()).set(bearer(token)).send(body as object);
};

const sub = { plan_code: "plus_yearly", payment_token_ref: "tok_a", method: "card", device_id: "dev-a" };

describe("authentication and audience", () => {
  it("every shopper route needs a bearer token", async () => {
    for (const [m, p] of [
      ["get", "/v1/plus/plans"],
      ["get", "/v1/me/plus"],
      ["post", "/v1/plus/subscribe"],
      ["post", "/v1/plus/cancel"],
      ["post", "/v1/plus/pause"],
      ["post", "/v1/plus/resume"],
      ["post", "/v1/plus/reactivate"],
      ["post", "/v1/plus/switch-plan"],
      ["post", "/v1/plus/refund"],
    ] as const) {
      const r = m === "get" ? await get(p) : await post(p, null);
      expect(r.status, `${m} ${p}`).toBe(401);
    }
  });

  it("a seller or admin token is not accepted on the buyer API", async () => {
    expect((await get("/v1/me/plus", TOKENS.seller)).status).toBe(401);
    expect((await post("/v1/plus/cancel", TOKENS.seller)).status).toBe(401);
  });
});

describe("paywall", () => {
  it("lists real plan prices as string piastres with the derived yearly offer", async () => {
    const r = await get("/v1/plus/plans", TOKENS.a);
    expect(r.status).toBe(200);
    expect(r.body.plans).toHaveLength(2);
    const yearly = r.body.plans.find((p: { code: string }) => p.code === "plus_yearly");
    expect(yearly).toMatchObject({ price: { amount_minor: "80000", currency: "EGP" }, trial_days: 14, default: true });
    expect(r.body.yearly_offer).toEqual({ pay_months: 4, free_months: 8, saving: { amount_minor: "160000", currency: "EGP" } });
    expect(r.body.auto_renew).toBe(true);
  });
});

describe("subscribe", () => {
  it("requires an Idempotency-Key and refuses unknown or client-side price fields", async () => {
    const noKey = await post("/v1/plus/subscribe", TOKENS.a, sub, {});
    expect(noKey.status).toBe(400);
    const priced = await post("/v1/plus/subscribe", TOKENS.a, { ...sub, price_minor: "1" });
    expect(priced.status).toBe(400);
    const badPlan = await post("/v1/plus/subscribe", TOKENS.a, { ...sub, plan_code: "../x" });
    expect(badPlan.status).toBe(400);
  });

  it("a 20 year old gets 403 age_gate and nothing is charged", async () => {
    const before = h.charges.requests.length;
    const r = await post("/v1/plus/subscribe", TOKENS.young, { ...sub, payment_token_ref: "tok_young" });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("age_gate");
    expect(h.charges.requests.length).toBe(before);
    expect((await get("/v1/me/plus", TOKENS.young)).body.subscription).toBeNull();
  });

  it("a token that is not the caller's card is 422", async () => {
    const r = await post("/v1/plus/subscribe", TOKENS.a, { ...sub, payment_token_ref: "tok_b" });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("invalid_payment_method");
  });

  it("starts the trial, and the same key replays to the same subscription", async () => {
    const key = idem();
    const a = await post("/v1/plus/subscribe", TOKENS.a, sub, key);
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ trial: true, subscription: { status: "TRIALING", plan_code: "plus_yearly" } });
    const again = await post("/v1/plus/subscribe", TOKENS.a, sub, key);
    expect(again.body.subscription.id).toBe(a.body.subscription.id);
    const other = await post("/v1/plus/subscribe", TOKENS.a, sub);
    expect(other.body.subscription.id).toBe(a.body.subscription.id);
    expect(other.body.trial).toBe(false);
    expect(h.charges.requests).toHaveLength(0);
  });

  it("the kill switch answers 503 and creates nothing", async () => {
    h.flags.disable("kill.plus.sales");
    const r = await post("/v1/plus/subscribe", TOKENS.b, { ...sub, payment_token_ref: "tok_b" });
    h.flags.enable("kill.plus.sales");
    expect(r.status).toBe(503);
    expect(r.body.code).toBe("plus_unavailable");
    expect((await get("/v1/me/plus", TOKENS.b)).body.subscription).toBeNull();
  });
});

describe("me and ownership", () => {
  it("shows only the caller's own subscription, entitlements and no card reference", async () => {
    const a = await get("/v1/me/plus", TOKENS.a);
    expect(a.status).toBe(200);
    expect(a.body.subscription.status).toBe("TRIALING");
    expect(a.body.entitlements.active).toBe(true);
    expect(a.body.entitlements.groups.app_features).toEqual([]);
    expect(a.body.entitlements.groups.commerce_benefits).toContain("free_delivery");
    expect(JSON.stringify(a.body)).not.toContain("tok_a");
    const b = await get("/v1/me/plus", TOKENS.b);
    expect(b.body.subscription).toBeNull();
    expect(b.body.entitlements.active).toBe(false);
  });

  it("management routes act on the caller only: a user without a subscription gets 404", async () => {
    for (const p of ["/v1/plus/cancel", "/v1/plus/resume", "/v1/plus/reactivate", "/v1/plus/refund"]) {
      expect((await post(p, TOKENS.b)).status, p).toBe(404);
    }
    expect((await post("/v1/plus/pause", TOKENS.b, { months: 1 })).status).toBe(404);
    expect((await post("/v1/plus/switch-plan", TOKENS.b, { plan_code: "plus_monthly" })).status).toBe(404);
  });

  it("there is no benefit-writing route (savings ledger is system only)", async () => {
    expect((await post("/v1/plus/benefits", TOKENS.a, { benefit: "free_delivery", amount_saved_minor: "1" })).status).toBe(404);
  });
});

describe("manage", () => {
  it("validates pause months and strict bodies", async () => {
    expect((await post("/v1/plus/pause", TOKENS.a, { months: 4 })).status).toBe(400);
    expect((await post("/v1/plus/pause", TOKENS.a, { months: 1, extra: true })).status).toBe(400);
    expect((await post("/v1/plus/switch-plan", TOKENS.a, { plan_code: "plus_yearly", price: 1 })).status).toBe(400);
  });

  it("cancel is one call, benefits stay until period end, then the sweeper expires it", async () => {
    const c = await post("/v1/plus/cancel", TOKENS.a);
    expect(c.status).toBe(200);
    expect(c.body.subscription.status).toBe("CANCELLED_AT_PERIOD_END");
    const me = await get("/v1/me/plus", TOKENS.a);
    expect(me.body.entitlements.active).toBe(true);
    expect(me.body.subscription.cancel_at).toBe(me.body.subscription.period_end);
    const back = await post("/v1/plus/reactivate", TOKENS.a);
    expect(back.body.subscription.status).toBe("ACTIVE");
    await post("/v1/plus/cancel", TOKENS.a);
    h.clock.advance(15 * DAY);
    const s = await h.sweep.execute();
    expect(s.expired).toBe(1);
    const after = await get("/v1/me/plus", TOKENS.a);
    expect(after.body.entitlements.active).toBe(false);
    expect(after.body.subscription.status).toBe("EXPIRED");
  });
});

describe("recurring webhook", () => {
  it("rejects an unsigned request and a verified one without a matching signup is a no-op 200", async () => {
    tick();
    const bad = await h.http().post("/v1/webhooks/fake_psp/recurring").send({ kind: "signup.charge_failed" });
    expect(bad.status).toBe(401);
    tick();
    const ok = await h
      .http()
      .post("/v1/webhooks/fake_psp/recurring")
      .set("x-test-signature", "ok")
      .send({ provider: "fake_psp", eventId: "e1", kind: "signup.charge_failed", signupId: "00000000-0000-4000-8000-0000000000ff" });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ received: true });
  });

  it("completes a 3-DS signup from the webhook; a duplicate delivery changes nothing", async () => {
    // user b: claim the trial with another identity first by using b's card on a trial-less path
    h.charges.script({
      kind: "requires_action",
      provider: "fake_psp",
      pspRef: "p9",
      action: { type: "redirect", url: "https://psp.test/3ds" },
    });
    // user b has no trial history, so force the paid path with a trial-less plan seed: use a card already claimed
    const claimed = await post("/v1/plus/subscribe", TOKENS.b, { ...sub, payment_token_ref: "tok_b", plan_code: "plus_monthly", device_id: "dev-b" });
    expect(claimed.status).toBe(201);
    expect(claimed.body.trial).toBe(true);
    // The scripted 3-DS outcome is consumed by the next paid charge (the pending signup below).
    expect((await post("/v1/plus/cancel", TOKENS.b)).status).toBe(200);
    h.clock.advance(15 * DAY);
    await h.sweep.execute();
    const r = await post("/v1/plus/subscribe", TOKENS.b, { ...sub, payment_token_ref: "tok_b", plan_code: "plus_monthly", device_id: "dev-b" });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe("requires_action");
    expect(r.body.client_action).toEqual({ type: "redirect", url: "https://psp.test/3ds" });
    const ev = { provider: "fake_psp", eventId: "e-3ds", kind: "signup.charge_succeeded", signupId: r.body.signup_id, pspRef: "p9" };
    tick();
    const w1 = await h.http().post("/v1/webhooks/fake_psp/recurring").set("x-test-signature", "ok").send(ev);
    expect(w1.status).toBe(200);
    tick();
    const w2 = await h.http().post("/v1/webhooks/fake_psp/recurring").set("x-test-signature", "ok").send(ev);
    expect(w2.status).toBe(200);
    const me = await get("/v1/me/plus", TOKENS.b);
    expect(me.body.subscription).toMatchObject({ status: "ACTIVE", plan_code: "plus_monthly" });
    expect(h.ledger.entries.filter((e) => e.kind === "plus_charged")).toHaveLength(1);
  });
});

describe("admin plans", () => {
  const publish = { code: "plus_monthly", interval: "month", price_minor: "25000", trial_days: 14, approval_id: "0192f3a4-5b6c-7d8e-9f01-aaaaaaaaaaaa" };
  const eff = (days: number): string => new Date(h.clock.nowMs() + days * DAY).toISOString();

  it("is not reachable by a shopper token, a wrong audience, or a support role", async () => {
    expect((await get("/v1/admin/plus/plans", TOKENS.a)).status).toBe(401);
    expect((await get("/v1/admin/plus/plans", TOKENS.shopperOnAdminAud)).status).toBe(403);
    expect((await get("/v1/admin/plus/plans", TOKENS.support)).status).toBe(403);
    expect((await post("/v1/admin/plus/plans", TOKENS.support, { ...publish, effective_from: eff(40) })).status).toBe(403);
    expect((await get("/v1/admin/plus/plans", TOKENS.finance)).status).toBe(200);
  });

  it("a price change needs 30 days notice and an approved dual approval, then notifies members", async () => {
    const short = await post("/v1/admin/plus/plans", TOKENS.finance, { ...publish, effective_from: eff(10) });
    expect(short.status).toBe(422);
    expect(short.body.code).toBe("notice_too_short");
    const noApproval = await post("/v1/admin/plus/plans", TOKENS.finance, { ...publish, effective_from: eff(40) });
    expect(noApproval.status).toBe(403);
    expect(noApproval.body.code).toBe("dual_approval_required");
    h.approvals.approve(publish.approval_id);
    const ok = await post("/v1/admin/plus/plans", TOKENS.finance, { ...publish, effective_from: eff(40) });
    expect(ok.status).toBe(201);
    expect(ok.body.plan).toMatchObject({ code: "plus_monthly", version: 2, price: { amount_minor: "25000" }, active: true });
    const list = await get("/v1/admin/plus/plans", TOKENS.finance);
    expect(list.body.items.length).toBeGreaterThanOrEqual(3);
    // the shopper paywall still shows the version in force now
    const paywall = await get("/v1/plus/plans", TOKENS.a);
    expect(paywall.body.plans.find((p: { code: string }) => p.code === "plus_monthly").price.amount_minor).toBe("20000");
  });

  it("deactivates a version; a missing plan is 404; money must be a positive integer string", async () => {
    expect((await patch("/v1/admin/plus/plans/00000000-0000-4000-8000-0000000000fe", TOKENS.finance, { active: false })).status).toBe(404);
    expect((await patch("/v1/admin/plus/plans/not-a-uuid", TOKENS.finance, { active: false })).status).toBe(400);
    expect((await patch("/v1/admin/plus/plans/00000000-0000-4000-8000-0000000000fe", TOKENS.support, { active: false })).status).toBe(403);
    const bad = await post("/v1/admin/plus/plans", TOKENS.finance, { ...publish, price_minor: "-5", effective_from: eff(40) });
    expect(bad.status).toBe(400);
    const decimal = await post("/v1/admin/plus/plans", TOKENS.finance, { ...publish, price_minor: "199.5", effective_from: eff(40) });
    expect(decimal.status).toBe(400);
  });
});

void USERS;

describe("GET /v1/admin/subscriptions/metrics", () => {
  const path = "/v1/admin/subscriptions/metrics";
  it("401 without a token or with a buyer-audience admin token or a shopper token", async () => {
    expect((await get(path)).status).toBe(401);
    expect((await get(path, TOKENS.a)).status).toBe(401);
    expect((await get(path, TOKENS.adminOnBuyerAud)).status).toBe(401);
    expect((await get(path, TOKENS.seller)).status).toBe(401);
  });
  it("403 for a support admin; 400 for a bad window", async () => {
    expect((await get(path, TOKENS.support)).status).toBe(403);
    expect((await get(`${path}?window_days=0`, TOKENS.finance)).status).toBe(400);
    expect((await get(`${path}?window_days=x`, TOKENS.finance)).status).toBe(400);
  });
  it("returns stored counts, with churn null when nothing was live at window start", async () => {
    const r = await get(path, TOKENS.finance);
    expect(r.status).toBe(200);
    for (const k of ["active", "trialing", "past_due", "paused", "cancelled_at_period_end", "expired", "new_in_window", "live_at_window_start", "ended_in_window"]) {
      expect(typeof r.body[k]).toBe("number");
    }
    expect(r.body.window_days).toBe(30);
    expect(r.body.live_at_window_start === 0 ? r.body.churn_bps : 0).toBe(r.body.live_at_window_start === 0 ? null : 0);
  });
});
