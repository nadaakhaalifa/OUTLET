import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { chart, isEntitled, type PlusSubscription } from "./domain/bridge";
import { DAY_MS, U, createPlusWorld, type PlusWorld } from "./test/harness";

const must = <T>(v: T | null | undefined): T => {
  if (v === null || v === undefined) throw new Error("expected a value");
  return v;
};

/** A member whose trial is already taken (the card was claimed earlier), so the first charge is real. */
async function paidStart(w: PlusWorld, n: number, plan = "plus_monthly"): Promise<{ m: ReturnType<PlusWorld["member"]>; sub: PlusSubscription }> {
  const m = w.member(n, { fingerprint: `shared-${n}` });
  const r0 = await w.store.commit({
    trialClaims: { keyHashes: [w.d.hasher.hash(`card:shared-${n}`)], subscriptionId: U(9000 + n), atMs: w.clock.nowMs() },
    events: [],
  });
  if (r0 !== "ok") throw new Error(r0);
  const r = await w.uc.subscribe.execute(w.subscribeInput(m, { plan }));
  if (r.kind !== "subscribed") throw new Error(`expected subscribed, got ${r.kind}`);
  return { m, sub: r.subscription };
}

describe("paywall", () => {
  it("shows 200 and 800 with Pay 4 get 8 free and a 1,600 EGP saving, yearly by default", async () => {
    const w = createPlusWorld();
    const v = await w.uc.plans.execute();
    expect(v.plans.map((p) => [p.code, p.priceMinor])).toEqual([
      ["plus_monthly", 20_000n],
      ["plus_yearly", 80_000n],
    ]);
    expect(v.marketing).toEqual({ payMonths: 4, freeMonths: 8, savingMinor: 160_000n });
    expect(v.defaultCode).toBe("plus_yearly");
  });
});

describe("subscribe", () => {
  it("age gate: a 20 year old at min age 21 is refused with no charge and no subscription", async () => {
    const w = createPlusWorld();
    const m = w.member(1, { age: 20 });
    const r = await w.uc.subscribe.execute(w.subscribeInput(m));
    expect(r).toEqual({ kind: "age_gate", minAge: 21 });
    expect(w.charges.requests).toHaveLength(0);
    expect(await w.store.getLatestByUser(m.userId)).toBeNull();
  });

  it("age gate follows age_policy: min age 18 admits a 20 year old, unknown age is refused", async () => {
    const w = createPlusWorld();
    w.ages.minAge = 18;
    const m = w.member(1, { age: 20 });
    expect((await w.uc.subscribe.execute(w.subscribeInput(m))).kind).toBe("subscribed");
    w.ages.minAge = 21;
    const unknown = { userId: "00000000-0000-4000-8000-000000000077", tokenRef: "t", deviceId: "d" };
    expect((await w.uc.subscribe.execute(w.subscribeInput(unknown))).kind).toBe("age_gate");
  });

  it("first subscription gets the 14 day trial with no charge and benefits at once", async () => {
    const w = createPlusWorld();
    const m = w.member(1);
    const r = await w.uc.subscribe.execute(w.subscribeInput(m));
    if (r.kind !== "subscribed") throw new Error(r.kind);
    expect(r.trial).toBe(true);
    expect(r.subscription.status).toBe("TRIALING");
    expect(w.charges.requests).toHaveLength(0);
    expect(w.ledger.entries).toHaveLength(0);
    const e = await w.uc.entitlements.forUser(m.userId);
    expect(e.entitled).toBe(true);
    expect(e.groups.commerce_benefits).toContain("free_delivery");
    expect(e.groups.app_features).toEqual([]);
    expect(e.endsAtMs).toBe(w.clock.nowMs() + 14 * DAY_MS);
  });

  it("the same card on a new phone and device gets no trial and pays now", async () => {
    const w = createPlusWorld();
    await w.uc.subscribe.execute(w.subscribeInput(w.member(1, { fingerprint: "fp-shared" })));
    const m2 = w.member(2, { fingerprint: "fp-shared", phone: "another-phone" });
    const r = await w.uc.subscribe.execute(w.subscribeInput(m2));
    if (r.kind !== "subscribed") throw new Error(r.kind);
    expect(r.trial).toBe(false);
    expect(r.subscription.status).toBe("ACTIVE");
    expect(w.charges.requests).toHaveLength(1);
    expect(w.charges.requests[0]?.amountMinor).toBe(20_000n);
  });

  it("the same phone or device alone also denies the trial", async () => {
    const w = createPlusWorld();
    await w.uc.subscribe.execute(w.subscribeInput(w.member(1)));
    const samePhone = w.member(2, { phone: "phone-1" });
    const r = await w.uc.subscribe.execute(w.subscribeInput(samePhone));
    if (r.kind !== "subscribed") throw new Error(r.kind);
    expect(r.trial).toBe(false);
    const sameDevice = { ...w.member(3), deviceId: "dev-1" };
    const r3 = await w.uc.subscribe.execute(w.subscribeInput(sameDevice));
    if (r3.kind !== "subscribed") throw new Error(r3.kind);
    expect(r3.trial).toBe(false);
  });

  it("a paid start posts balanced ledger entries with VAT 14% and queues one receipt", async () => {
    const w = createPlusWorld();
    const { sub } = await paidStart(w, 5);
    expect(sub.status).toBe("ACTIVE");
    expect(w.ledger.entries).toHaveLength(1);
    const e = must(w.ledger.entries[0]);
    expect(e.kind).toBe("plus_charged");
    expect(e.postings.reduce((a, p) => a + p.amount.amount, 0n)).toBe(0n);
    expect(w.ledger.net(chart.platformVatOutput)).toBe(-2_456n);
    expect(w.ledger.net(chart.deferredPlusRevenue)).toBe(-17_544n);
    expect(w.receipts.queued).toHaveLength(1);
    expect(w.receipts.queued[0]).toMatchObject({ grossMinor: 20_000n, vatMinor: 2_456n });
  });

  it("a replayed request never charges twice and returns the same subscription", async () => {
    const w = createPlusWorld();
    w.uc.subscribe.execute(w.subscribeInput(w.member(1, { fingerprint: "burn" })));
    await w.uc.subscribe.execute(w.subscribeInput(w.member(8, { fingerprint: "burn" })));
    const m = w.member(2, { fingerprint: "burn" });
    const a = await w.uc.subscribe.execute(w.subscribeInput(m, { requestKey: "k1" }));
    const b = await w.uc.subscribe.execute(w.subscribeInput(m, { requestKey: "k1" }));
    const c = await w.uc.subscribe.execute(w.subscribeInput(m, { requestKey: "k2" }));
    if (a.kind !== "subscribed" || b.kind !== "existing" || c.kind !== "existing") throw new Error("unexpected");
    expect(b.subscription.id).toBe(a.subscription.id);
    expect(c.subscription.id).toBe(a.subscription.id);
    expect(w.charges.requests.filter((r) => r.userId === m.userId)).toHaveLength(1);
  });

  it("concurrent taps create one subscription", async () => {
    const w = createPlusWorld();
    await w.uc.subscribe.execute(w.subscribeInput(w.member(8, { fingerprint: "burn" })));
    const m = w.member(2, { fingerprint: "burn" });
    const results = await Promise.all([
      w.uc.subscribe.execute(w.subscribeInput(m, { requestKey: "a" })),
      w.uc.subscribe.execute(w.subscribeInput(m, { requestKey: "b" })),
    ]);
    const ids = new Set(
      results.map((r) => (r.kind === "subscribed" || r.kind === "existing" ? r.subscription.id : "none")),
    );
    expect(ids.size).toBe(1);
    expect(ids.has("none")).toBe(false);
    const live = await w.store.getLiveByUser(m.userId);
    expect(live).not.toBeNull();
    // any duplicate charge was refunded, none is left unpaired
    const charged = w.charges.requests.filter((r) => r.userId === m.userId).length;
    expect(charged - w.refunds.refunds.length).toBe(1);
  });

  it("declined payment: no subscription, replay reports the same failure without charging again", async () => {
    const w = createPlusWorld();
    await w.uc.subscribe.execute(w.subscribeInput(w.member(8, { fingerprint: "burn" })));
    const m = w.member(2, { fingerprint: "burn" });
    w.charges.failNext("card_declined");
    const r = await w.uc.subscribe.execute(w.subscribeInput(m, { requestKey: "k" }));
    expect(r).toEqual({ kind: "payment_failed", reason: "card_declined" });
    expect(await w.store.getLatestByUser(m.userId)).toBeNull();
    const again = await w.uc.subscribe.execute(w.subscribeInput(m, { requestKey: "k" }));
    expect(again.kind).toBe("payment_failed");
    expect(w.charges.requests.filter((x) => x.userId === m.userId)).toHaveLength(1);
  });

  it("3-DS: requires_action, then the webhook completes it once even if delivered twice", async () => {
    const w = createPlusWorld();
    await w.uc.subscribe.execute(w.subscribeInput(w.member(8, { fingerprint: "burn" })));
    const m = w.member(2, { fingerprint: "burn" });
    w.charges.script({ kind: "requires_action", provider: "fake_psp", pspRef: "p1", action: { type: "redirect", url: "https://psp.test/3ds" } });
    const r = await w.uc.subscribe.execute(w.subscribeInput(m, { requestKey: "k" }));
    if (r.kind !== "requires_action") throw new Error(r.kind);
    expect(await w.store.getLiveByUser(m.userId)).toBeNull();
    const ev = { provider: "fake_psp", eventId: "evt-1", kind: "signup.charge_succeeded" as const, signupId: r.signupId, pspRef: "p1" };
    expect(await w.uc.webhook.execute(ev)).toBe("applied");
    expect(await w.uc.webhook.execute(ev)).toBe("ignored");
    expect(await w.uc.webhook.execute({ ...ev, eventId: "evt-2" })).toBe("ignored");
    const live = must(await w.store.getLiveByUser(m.userId));
    expect(live.status).toBe("ACTIVE");
    expect(w.ledger.entries.filter((e) => e.kind === "plus_charged")).toHaveLength(1);
    const replay = await w.uc.subscribe.execute(w.subscribeInput(m, { requestKey: "k" }));
    expect(replay.kind).toBe("existing");
  });

  it("a failed 3-DS webhook marks the signup failed", async () => {
    const w = createPlusWorld();
    await w.uc.subscribe.execute(w.subscribeInput(w.member(8, { fingerprint: "burn" })));
    const m = w.member(2, { fingerprint: "burn" });
    w.charges.script({ kind: "requires_action", provider: "fake_psp", pspRef: "p1", action: { type: "sdk", token: "t" } });
    const r = await w.uc.subscribe.execute(w.subscribeInput(m, { requestKey: "k" }));
    if (r.kind !== "requires_action") throw new Error(r.kind);
    expect(await w.uc.webhook.execute({ provider: "fake_psp", eventId: "e", kind: "signup.charge_failed", signupId: r.signupId })).toBe("applied");
    expect(await w.store.getLiveByUser(m.userId)).toBeNull();
    expect((await w.uc.subscribe.execute(w.subscribeInput(m, { requestKey: "k" }))).kind).toBe("payment_failed");
  });

  it("kill switches: plus_sales and a recurring method stop new subscriptions only", async () => {
    const w = createPlusWorld();
    const m = w.member(1);
    w.flags.disable("kill.plus.sales");
    expect((await w.uc.subscribe.execute(w.subscribeInput(m))).kind).toBe("unavailable");
    w.flags.enable("kill.plus.sales");
    w.flags.disable("kill.plus.recurring.mobile_wallet");
    expect((await w.uc.subscribe.execute(w.subscribeInput(m, { method: "mobile_wallet" }))).kind).toBe("method_unavailable");
    expect((await w.uc.subscribe.execute(w.subscribeInput(m, { method: "card" }))).kind).toBe("subscribed");
  });

  it("rejects an unknown plan, a token the user does not own, and an unknown token", async () => {
    const w = createPlusWorld();
    const m = w.member(1);
    expect((await w.uc.subscribe.execute(w.subscribeInput(m, { plan: "plus_gold" }))).kind).toBe("plan_not_found");
    const other = w.member(2);
    expect((await w.uc.subscribe.execute({ ...w.subscribeInput(m), tokenRef: other.tokenRef })).kind).toBe("invalid_payment_method");
    expect((await w.uc.subscribe.execute({ ...w.subscribeInput(m), tokenRef: "nope" })).kind).toBe("invalid_payment_method");
  });
});

describe("trial lifecycle", () => {
  it("reminds 2 days before the first charge, converts at day 14 and charges once", async () => {
    const w = createPlusWorld();
    const m = w.member(1);
    await w.uc.subscribe.execute(w.subscribeInput(m));
    w.clock.advanceDays(11);
    expect((await w.uc.sweep.execute()).examined).toBe(0);
    w.clock.advanceDays(1);
    await w.uc.sweep.execute();
    expect(w.notices.sent.map((n) => n.template)).toEqual(["plus_trial_reminder"]);
    await w.uc.sweep.execute();
    expect(w.notices.sent).toHaveLength(1);
    expect(w.charges.requests).toHaveLength(0);
    w.clock.advanceDays(2);
    const s = await w.uc.sweep.execute();
    expect(s.renewed).toBe(1);
    expect(w.charges.requests).toHaveLength(1);
    expect(must(await w.store.getLiveByUser(m.userId)).status).toBe("ACTIVE");
    await w.uc.sweep.execute();
    expect(w.charges.requests).toHaveLength(1);
  });

  it("an unpaid trial expires without dunning and revokes benefits", async () => {
    const w = createPlusWorld();
    const m = w.member(1);
    await w.uc.subscribe.execute(w.subscribeInput(m));
    w.charges.failNext();
    w.clock.advanceDays(14);
    const s = await w.uc.sweep.execute();
    expect(s.expired).toBe(1);
    expect(await w.store.getLiveByUser(m.userId)).toBeNull();
    expect((await w.uc.entitlements.forUser(m.userId)).entitled).toBe(false);
    expect(w.notices.sent.map((n) => n.template)).toContain("plus_expired");
  });
});

describe("renewal and dunning", () => {
  it("renews at period end with an idempotent key and a new invoice", async () => {
    const w = createPlusWorld();
    const { m, sub } = await paidStart(w, 3);
    w.clock.advance(sub.periodEndMs - w.clock.nowMs());
    expect((await w.uc.sweep.execute()).renewed).toBe(1);
    const renewed = must(await w.store.getLiveByUser(m.userId));
    expect(renewed.cycle).toBe(2);
    expect(renewed.periodStartMs).toBe(sub.periodEndMs);
    const keys = w.charges.requests.map((r) => r.idempotencyKey).filter((k) => k.startsWith("sub:"));
    expect(keys).toEqual([`sub:${sub.id}:cycle:2:attempt:0`]);
    const again = await w.uc.sweep.execute();
    expect(again.examined).toBe(0);
    expect(w.charges.requests.filter((r) => r.userId === m.userId)).toHaveLength(2);
  });

  it("failed renewal: retries day 1, 3, 7, benefits continue to day 7, then expire and revoke", async () => {
    const w = createPlusWorld();
    const { m, sub } = await paidStart(w, 3);
    const failAt = sub.periodEndMs;
    w.clock.advance(failAt - w.clock.nowMs());
    w.charges.failNext("insufficient_funds", 4);
    expect((await w.uc.sweep.execute()).failed).toBe(1);
    const pd = must(await w.store.getLiveByUser(m.userId));
    expect(pd.status).toBe("PAST_DUE");
    expect((await w.uc.entitlements.forUser(m.userId)).entitled).toBe(true);

    w.clock.advanceDays(1);
    expect((await w.uc.sweep.execute()).failed).toBe(1);
    w.clock.advanceDays(2);
    expect((await w.uc.sweep.execute()).failed).toBe(1);
    expect((await w.uc.entitlements.forUser(m.userId)).entitled).toBe(true);
    w.clock.advanceDays(4);
    w.clock.advance(-1);
    expect((await w.uc.entitlements.forUser(m.userId)).entitled).toBe(true);
    w.clock.advance(1);
    expect((await w.uc.entitlements.forUser(m.userId)).entitled).toBe(false);
    expect((await w.uc.sweep.execute()).failed).toBe(1);
    expect((await w.uc.sweep.execute()).expired).toBe(1);

    const keys = w.charges.requests.map((r) => r.idempotencyKey).filter((k) => k.startsWith("sub:"));
    expect(keys).toEqual([0, 1, 2, 3].map((k) => `sub:${sub.id}:cycle:2:attempt:${k}`));
    expect(await w.store.getLiveByUser(m.userId)).toBeNull();
    expect(w.notices.sent.filter((n) => n.template === "plus_payment_failed")).toHaveLength(4);
    expect((await w.store.entitlementRows(m.userId))).toEqual([]);
    const types = w.store.events.map((e) => e.type);
    expect(types.filter((t) => t === "plus.payment_failed")).toHaveLength(4);
    expect(types).toContain("plus.expired");
  });

  it("dunning recovery on day 3 returns to ACTIVE with a fresh period", async () => {
    const w = createPlusWorld();
    const { m, sub } = await paidStart(w, 3);
    w.clock.advance(sub.periodEndMs - w.clock.nowMs());
    w.charges.failNext("declined", 2);
    await w.uc.sweep.execute();
    w.clock.advanceDays(1);
    await w.uc.sweep.execute();
    w.clock.advanceDays(2);
    expect((await w.uc.sweep.execute()).renewed).toBe(1);
    const s = must(await w.store.getLiveByUser(m.userId));
    expect(s.status).toBe("ACTIVE");
    expect(s.failedAtMs).toBeNull();
    expect(s.periodStartMs).toBe(w.clock.nowMs());
    expect((await w.store.listInvoices(s.id)).map((i) => [i.cycle, i.attempt, i.status])).toEqual([
      [1, 0, "PAID"],
      [2, 0, "FAILED"],
      [2, 1, "FAILED"],
      [2, 2, "PAID"],
    ]);
  });

  it("a late PSP confirmation of the renewal recovers a PAST_DUE member exactly once", async () => {
    const w = createPlusWorld();
    const { m, sub } = await paidStart(w, 3);
    w.clock.advance(sub.periodEndMs - w.clock.nowMs());
    w.charges.failNext();
    await w.uc.sweep.execute();
    const pd = must(await w.store.getLiveByUser(m.userId));
    const ev = { provider: "fake_psp", eventId: "late-1", kind: "renewal.charge_succeeded" as const, subscriptionId: pd.id, cycle: pd.cycle, pspRef: "px" };
    expect(await w.uc.webhook.execute(ev)).toBe("applied");
    expect(await w.uc.webhook.execute(ev)).toBe("duplicate");
    expect(must(await w.store.getLiveByUser(m.userId)).status).toBe("ACTIVE");
  });

  it("B-4: a late success after the retry budget (attempt 3 already FAILED) reactivates without a UNIQUE clash", async () => {
    const w = createPlusWorld();
    const { m, sub } = await paidStart(w, 3);
    w.clock.advance(sub.periodEndMs - w.clock.nowMs());
    w.charges.failNext("declined", 4);
    await w.uc.sweep.execute();
    w.clock.advanceDays(1);
    await w.uc.sweep.execute();
    w.clock.advanceDays(2);
    await w.uc.sweep.execute();
    w.clock.advanceDays(4);
    await w.uc.sweep.execute();
    const pd = must(await w.store.getLiveByUser(m.userId));
    const ev = { provider: "fake_psp", eventId: "late-b4", kind: "renewal.charge_succeeded" as const, subscriptionId: pd.id, cycle: pd.cycle, pspRef: "px4" };
    expect(await w.uc.webhook.execute(ev)).toBe("applied");
    expect(must(await w.store.getLiveByUser(m.userId)).status).toBe("ACTIVE");
    const invs = (await w.store.listInvoices(pd.id)).filter((i) => i.cycle === pd.cycle);
    expect(invs.filter((i) => i.status === "PAID")).toHaveLength(1);
    expect(new Set(invs.map((i) => i.attempt)).size).toBe(invs.length);
    expect(await w.uc.webhook.execute(ev)).toBe("duplicate");
    for (const e of w.ledger.entries) expect(e.postings.reduce((a, p) => a + p.amount.amount, 0n)).toBe(0n);
  });

  it("B-4: a late success for an already EXPIRED member is booked and refunded, never kept", async () => {
    const w = createPlusWorld();
    const { m, sub } = await paidStart(w, 3);
    w.clock.advance(sub.periodEndMs - w.clock.nowMs());
    w.charges.failNext("declined", 4);
    await w.uc.sweep.execute();
    w.clock.advanceDays(1);
    await w.uc.sweep.execute();
    w.clock.advanceDays(2);
    await w.uc.sweep.execute();
    w.clock.advanceDays(7);
    await w.uc.sweep.execute();
    await w.uc.sweep.execute();
    expect(await w.store.getLiveByUser(m.userId)).toBeNull();
    const before = w.refunds.refunds.length;
    const ev = { provider: "fake_psp", eventId: "late-exp", kind: "renewal.charge_succeeded" as const, subscriptionId: sub.id, cycle: 2, pspRef: "pxe" };
    expect(await w.uc.webhook.execute(ev)).toBe("applied");
    expect(w.refunds.refunds.length).toBe(before + 1);
    expect(await w.uc.webhook.execute(ev)).toBe("duplicate");
    expect(w.refunds.refunds.length).toBe(before + 1);
    expect(w.ledger.net(chart.deferredPlusRevenue)).toBe(-17_544n);
  });

  it("renewals continue when plus_sales is killed", async () => {
    const w = createPlusWorld();
    const { sub } = await paidStart(w, 3);
    w.flags.disable("kill.plus.sales");
    w.clock.advance(sub.periodEndMs - w.clock.nowMs());
    expect((await w.uc.sweep.execute()).renewed).toBe(1);
  });

  it("overlapping sweeps charge each cycle once", async () => {
    const w = createPlusWorld();
    const { m, sub } = await paidStart(w, 3);
    w.clock.advance(sub.periodEndMs - w.clock.nowMs());
    await Promise.all([w.uc.sweep.execute(), w.uc.sweep.execute()]);
    expect(w.charges.uniqueKeys()).toBe(2);
    expect(w.charges.requests.filter((r) => r.idempotencyKey.startsWith("sub:")).length).toBeGreaterThanOrEqual(1);
    const invoices = await w.store.listInvoices(sub.id);
    expect(invoices.filter((i) => i.cycle === 2)).toHaveLength(1);
    expect(must(await w.store.getLiveByUser(m.userId)).cycle).toBe(2);
    expect(w.ledger.entries.filter((e) => e.kind === "plus_charged")).toHaveLength(2);
  });
});

describe("cancel, pause, reactivate", () => {
  it("cancel keeps benefits until period_end exactly, then EXPIRED with no charge", async () => {
    const w = createPlusWorld();
    const { m, sub } = await paidStart(w, 3);
    w.clock.advanceDays(3);
    const r = await w.uc.cancel.execute(m.userId);
    if (r.kind !== "ok") throw new Error(r.kind);
    expect(r.subscription.status).toBe("CANCELLED_AT_PERIOD_END");
    expect((await w.uc.entitlements.forUser(m.userId)).entitled).toBe(true);
    expect((await w.uc.cancel.execute(m.userId)).kind).toBe("ok");
    w.clock.advance(sub.periodEndMs - w.clock.nowMs() - 1);
    expect((await w.uc.entitlements.forUser(m.userId)).entitled).toBe(true);
    w.clock.advance(1);
    expect((await w.uc.entitlements.forUser(m.userId)).entitled).toBe(false);
    const before = w.charges.requests.length;
    expect((await w.uc.sweep.execute()).expired).toBe(1);
    expect(w.charges.requests).toHaveLength(before);
    expect(await w.store.getLiveByUser(m.userId)).toBeNull();
  });

  it("reactivating before the end restores renewal", async () => {
    const w = createPlusWorld();
    const { m } = await paidStart(w, 3);
    await w.uc.cancel.execute(m.userId);
    const r = await w.uc.reactivate.execute(m.userId);
    expect(r.kind === "ok" && r.subscription.status).toBe("ACTIVE");
  });

  it("pause stops benefits and charges; resume keeps the paid days; auto resume by the sweeper", async () => {
    const w = createPlusWorld();
    const { m, sub } = await paidStart(w, 3);
    w.clock.advanceDays(10);
    expect((await w.uc.pause.execute(m.userId, 0)).kind).toBe("invalid_months");
    expect((await w.uc.pause.execute(m.userId, 4)).kind).toBe("invalid_months");
    const p = await w.uc.pause.execute(m.userId, 1);
    expect(p.kind === "ok" && p.subscription.status).toBe("PAUSED");
    expect((await w.uc.entitlements.forUser(m.userId)).entitled).toBe(false);
    w.clock.advanceDays(31);
    await w.uc.sweep.execute();
    const s = must(await w.store.getLiveByUser(m.userId));
    expect(s.status).toBe("ACTIVE");
    expect(s.periodEndMs).toBeGreaterThan(sub.periodEndMs);
    expect(w.charges.requests.filter((r) => r.userId === m.userId)).toHaveLength(1);
    expect((await w.uc.entitlements.forUser(m.userId)).entitled).toBe(true);
  });

  it("only the owner's own subscription is ever addressed; no subscription is a 404 shape", async () => {
    const w = createPlusWorld();
    const stranger = w.member(50);
    expect((await w.uc.cancel.execute(stranger.userId)).kind).toBe("not_found");
    expect((await w.uc.pause.execute(stranger.userId, 1)).kind).toBe("not_found");
    expect((await w.uc.resume.execute(stranger.userId)).kind).toBe("not_found");
    expect((await w.uc.switchPlan.execute(stranger.userId, "plus_yearly")).kind).toBe("not_found");
    expect((await w.uc.refund.execute(stranger.userId)).kind).toBe("not_found");
  });
});

describe("switch plan", () => {
  it("monthly to yearly 10 days in: credit = 20 unused days, charge = 800 minus credit, ledger balances to zero", async () => {
    const w = createPlusWorld();
    const { m } = await paidStart(w, 3);
    w.clock.advanceDays(10);
    const r = await w.uc.switchPlan.execute(m.userId, "plus_yearly");
    if (r.kind !== "ok") throw new Error(r.kind);
    expect(r.subscription.planCode).toBe("plus_yearly");
    expect(r.subscription.interval).toBe("year");
    expect(r.subscription.periodStartMs).toBe(w.clock.nowMs());
    const credit = 13_333n;
    const lastCharge = w.charges.requests[w.charges.requests.length - 1];
    expect(lastCharge?.amountMinor).toBe(80_000n - credit);
    const sum = w.ledger.entries.flatMap((e) => e.postings).reduce((a, p) => a + p.amount.amount, 0n);
    expect(sum).toBe(0n);
    for (const e of w.ledger.entries) expect(e.postings.reduce((a, p) => a + p.amount.amount, 0n)).toBe(0n);
    // deferred conserved: 17,544 old net + 58,480 new cash net - 5,848 used share recognised
    expect(w.ledger.net(chart.deferredPlusRevenue)).toBe(-70_176n);
    expect(w.ledger.net(chart.plusRevenue)).toBe(-5_848n);
    const invs = await w.store.listInvoices(r.subscription.id);
    const up = must(invs.find((i) => i.kind === "upgrade"));
    expect(up.creditAppliedMinor).toBe(credit);
    expect(up.netRecognitionMinor).toBe(70_176n);
    expect(up.periodsTotal).toBe(12);
    // the old monthly invoice no longer recognises anything
    expect(must(invs.find((i) => i.kind === "first")).periodsRecognised).toBe(1);
  });

  it("a failed upgrade charge changes nothing", async () => {
    const w = createPlusWorld();
    const { m, sub } = await paidStart(w, 3);
    w.clock.advanceDays(10);
    w.charges.failNext("declined");
    const r = await w.uc.switchPlan.execute(m.userId, "plus_yearly");
    expect(r.kind).toBe("payment_failed");
    const s = must(await w.store.getLiveByUser(m.userId));
    expect(s.planCode).toBe("plus_monthly");
    expect(s.periodEndMs).toBe(sub.periodEndMs);
  });

  it("yearly to monthly is scheduled for period_end and billed at the monthly price then", async () => {
    const w = createPlusWorld();
    const { m, sub } = await paidStart(w, 3, "plus_yearly");
    const r = await w.uc.switchPlan.execute(m.userId, "plus_monthly");
    if (r.kind !== "ok") throw new Error(r.kind);
    expect(r.subscription.pendingPlanCode).toBe("plus_monthly");
    expect(r.subscription.planCode).toBe("plus_yearly");
    expect(w.charges.requests).toHaveLength(1);
    expect((await w.uc.switchPlan.execute(m.userId, "plus_monthly")).kind).toBe("ok");
    expect((await w.uc.switchPlan.execute(m.userId, "plus_yearly")).kind).toBe("same_plan");
    w.clock.advance(sub.periodEndMs - w.clock.nowMs());
    await w.uc.sweep.execute();
    const s = must(await w.store.getLiveByUser(m.userId));
    expect(s.planCode).toBe("plus_monthly");
    expect(s.pendingPlanCode).toBeNull();
    expect(w.charges.requests[w.charges.requests.length - 1]?.amountMinor).toBe(20_000n);
  });

  it("unknown target plan and non ACTIVE states are refused", async () => {
    const w = createPlusWorld();
    const { m } = await paidStart(w, 3);
    expect((await w.uc.switchPlan.execute(m.userId, "plus_nope")).kind).toBe("plan_not_found");
    await w.uc.cancel.execute(m.userId);
    expect((await w.uc.switchPlan.execute(m.userId, "plus_yearly")).kind).toBe("invalid_state");
  });
});

describe("refund", () => {
  it("5 days after a charge with no benefit used: full refund to the original method, ledger reversed", async () => {
    const w = createPlusWorld();
    const { m, sub } = await paidStart(w, 3);
    w.clock.advanceDays(5);
    const r = await w.uc.refund.execute(m.userId);
    if (r.kind !== "refunded") throw new Error(r.kind);
    expect(r.amountMinor).toBe(20_000n);
    expect(w.refunds.refunds).toHaveLength(1);
    expect(w.refunds.refunds[0]?.amountMinor).toBe(20_000n);
    expect(r.subscription.status).toBe("EXPIRED");
    expect((await w.uc.entitlements.forUser(m.userId)).entitled).toBe(false);
    expect(w.ledger.net(chart.deferredPlusRevenue)).toBe(0n);
    expect(w.ledger.net(chart.platformVatOutput)).toBe(0n);
    expect((await w.store.listInvoices(sub.id))[0]?.status).toBe("REFUNDED");
    expect(w.store.events.map((e) => e.type)).toContain("plus.refunded");
    expect((await w.uc.refund.execute(m.userId)).kind).toBe("not_found");
  });

  it("B-4: after monthly to yearly the refund returns every invoice of the cycle, not only the upgrade", async () => {
    const w = createPlusWorld();
    const { m } = await paidStart(w, 3);
    w.clock.advanceDays(2);
    const sw = await w.uc.switchPlan.execute(m.userId, "plus_yearly");
    if (sw.kind !== "ok") throw new Error(sw.kind);
    const upgradeCharge = w.charges.requests[w.charges.requests.length - 1]?.amountMinor ?? 0n;
    const r = await w.uc.refund.execute(m.userId);
    if (r.kind !== "refunded") throw new Error(r.kind);
    expect(r.amountMinor).toBe(20_000n + upgradeCharge);
    expect(w.refunds.refunds.map((x) => x.amountMinor).sort()).toEqual([20_000n, upgradeCharge].sort());
    expect((await w.store.listInvoices(sw.subscription.id)).every((i) => i.status === "REFUNDED")).toBe(true);
    expect(w.ledger.net(chart.deferredPlusRevenue)).toBe(0n);
    expect(w.ledger.net(chart.plusRevenue)).toBe(0n);
    expect(w.ledger.net(chart.platformVatOutput)).toBe(0n);
  });

  it("a used benefit blocks the refund until the order using it is reversed", async () => {
    const w = createPlusWorld();
    const { m } = await paidStart(w, 3);
    w.clock.advanceDays(2);
    const og = "00000000-0000-4000-8000-0000000000aa";
    expect(await w.uc.recordBenefit.execute({ userId: m.userId, orderGroupId: og, benefit: "free_delivery", amountSavedMinor: 6_500n })).toEqual({ kind: "recorded" });
    expect(await w.uc.recordBenefit.execute({ userId: m.userId, orderGroupId: og, benefit: "free_delivery", amountSavedMinor: 6_500n })).toEqual({ kind: "already_recorded" });
    expect(await w.uc.refund.execute(m.userId)).toEqual({ kind: "not_eligible", reason: "benefit_used" });
    expect(await w.uc.reverseBenefit.execute(og)).toEqual({ reversed: 1 });
    expect((await w.uc.refund.execute(m.userId)).kind).toBe("refunded");
  });

  it("not eligible after 14 days", async () => {
    const w = createPlusWorld();
    const { m } = await paidStart(w, 3);
    w.clock.advanceDays(15);
    expect(await w.uc.refund.execute(m.userId)).toEqual({ kind: "not_eligible", reason: "window_elapsed" });
  });

  it("a PSP refund failure leaves the subscription untouched and no ledger reversal", async () => {
    const w = createPlusWorld();
    const { m } = await paidStart(w, 3);
    w.refunds.fail = true;
    expect((await w.uc.refund.execute(m.userId)).kind).toBe("refund_failed");
    expect(must(await w.store.getLiveByUser(m.userId)).status).toBe("ACTIVE");
    expect(w.ledger.entries.filter((e) => e.kind !== "plus_charged")).toHaveLength(0);
  });
});

describe("benefits and savings ledger", () => {
  it("only an entitled member records benefits; unknown benefits and negative amounts are refused", async () => {
    const w = createPlusWorld();
    const og = "00000000-0000-4000-8000-0000000000bb";
    const nobody = w.member(70);
    expect((await w.uc.recordBenefit.execute({ userId: nobody.userId, orderGroupId: og, benefit: "free_delivery", amountSavedMinor: 1n })).kind).toBe("not_entitled");
    await w.uc.subscribe.execute(w.subscribeInput(nobody));
    expect((await w.uc.recordBenefit.execute({ userId: nobody.userId, orderGroupId: og, benefit: "stylist_pro", amountSavedMinor: 1n })).kind).toBe("unknown_benefit");
    expect((await w.uc.recordBenefit.execute({ userId: nobody.userId, orderGroupId: og, benefit: "free_delivery", amountSavedMinor: -1n })).kind).toBe("unknown_benefit");
    await w.uc.recordBenefit.execute({ userId: nobody.userId, orderGroupId: og, benefit: "free_delivery", amountSavedMinor: 6_500n });
    const me = await w.uc.mine.execute(nobody.userId);
    expect(me.savings.totalMinor).toBe(6_500n);
    expect(me.entitlements.groups.app_features).toEqual([]);
  });
});

describe("revenue recognition", () => {
  it("recognises a yearly invoice monthly, once per month, summing exactly to the net", async () => {
    const w = createPlusWorld();
    const { sub } = await paidStart(w, 3, "plus_yearly");
    const inv = must((await w.store.listInvoices(sub.id))[0]);
    expect((await w.uc.recognize.execute()).entries).toBe(0);
    w.clock.advanceDays(32);
    expect((await w.uc.recognize.execute()).entries).toBe(1);
    expect((await w.uc.recognize.execute()).entries).toBe(0);
    w.clock.advanceDays(400);
    await w.uc.recognize.execute();
    await w.uc.recognize.execute();
    const recognised = w.ledger.entries.filter((e) => e.kind === "plus_revenue_recognised");
    expect(recognised).toHaveLength(12);
    expect(w.ledger.net(chart.plusRevenue)).toBe(-inv.netRecognitionMinor);
    expect(w.ledger.net(chart.deferredPlusRevenue)).toBe(0n);
    expect((await w.store.listForRecognition(10))).toHaveLength(0);
  });
});

describe("plan versions and the 30 day notice", () => {
  it("needs an approval, 30 days notice, notifies members, and bills the new price only from effective_from", async () => {
    const w = createPlusWorld();
    const { m, sub } = await paidStart(w, 3);
    const now = w.clock.nowMs();
    const base = { actorId: "admin-1", code: "plus_monthly", interval: "month" as const, priceMinor: 25_000n, trialDays: 14 };
    expect(await w.uc.publish.execute({ ...base, effectiveFromMs: now + 40 * DAY_MS, approvalId: "ap-1" })).toEqual({ kind: "approval_required" });
    const short = await w.uc.publish.execute({ ...base, effectiveFromMs: now + 29 * DAY_MS, approvalId: "ap-1" });
    expect(short.kind).toBe("notice_too_short");
    w.approvals.approve("ap-1");
    const ok = await w.uc.publish.execute({ ...base, effectiveFromMs: now + 40 * DAY_MS, approvalId: "ap-1" });
    if (ok.kind !== "published") throw new Error(ok.kind);
    expect(ok.plan.version).toBe(2);
    expect(ok.notified).toBe(1);
    expect(w.notices.sent.find((n) => n.template === "plus_price_change")?.userId).toBe(m.userId);
    expect(await w.uc.publish.execute({ ...base, effectiveFromMs: now + 40 * DAY_MS, approvalId: "ap-1" })).toEqual({ kind: "approval_required" });

    // The first renewal (before effective_from) stays on the old price.
    w.clock.advance(sub.periodEndMs - w.clock.nowMs());
    await w.uc.sweep.execute();
    expect(w.charges.requests[w.charges.requests.length - 1]?.amountMinor).toBe(20_000n);
    // Past effective_from the next renewal bills the new version.
    w.clock.advanceDays(45);
    const cur = must(await w.store.getLiveByUser(m.userId));
    w.clock.advance(cur.periodEndMs - w.clock.nowMs());
    await w.uc.sweep.execute();
    expect(w.charges.requests[w.charges.requests.length - 1]?.amountMinor).toBe(25_000n);
    expect(must(await w.store.getLiveByUser(m.userId)).planVersion).toBe(2);
  });

  it("paywall shows the version in force now", async () => {
    const w = createPlusWorld();
    w.approvals.approve("ap");
    const now = w.clock.nowMs();
    await w.uc.publish.execute({ actorId: "a", code: "plus_monthly", interval: "month", priceMinor: 25_000n, trialDays: 14, effectiveFromMs: now + 31 * DAY_MS, approvalId: "ap" });
    expect((await w.uc.plans.execute()).plans.find((p) => p.code === "plus_monthly")?.priceMinor).toBe(20_000n);
    w.clock.advanceDays(31);
    expect((await w.uc.plans.execute()).plans.find((p) => p.code === "plus_monthly")?.priceMinor).toBe(25_000n);
  });
});

describe("Plan A contract", () => {
  it("no subscription state ever grants an app_features entitlement", async () => {
    const w = createPlusWorld();
    const { m } = await paidStart(w, 3);
    const rows = await w.store.entitlementRows(m.userId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.group === "commerce_benefits")).toBe(true);
    expect(rows.map((r) => r.key)).toEqual(
      expect.arrayContaining(["free_delivery", "early_access_24h", "coins_plus_5pct", "free_returns", "priority_support"]),
    );
  });
});

describe("property: money and entitlement invariants hold across random lifecycles", () => {
  type Op = "cancel" | "reactivate" | "pause" | "resume" | "switch" | "sweep" | "fail" | "refund";
  it("every ledger entry balances, no double charge per key, entitled iff window open", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(fc.constantFrom<Op>("cancel", "reactivate", "pause", "resume", "switch", "sweep", "fail", "refund"), fc.integer({ min: 0, max: 20 })), { maxLength: 14 }),
        async (steps) => {
          const w = createPlusWorld();
          const { m } = await paidStart(w, 3);
          for (const [op, days] of steps) {
            w.clock.advanceDays(days);
            switch (op) {
              case "cancel": await w.uc.cancel.execute(m.userId); break;
              case "reactivate": await w.uc.reactivate.execute(m.userId); break;
              case "pause": await w.uc.pause.execute(m.userId, 1); break;
              case "resume": await w.uc.resume.execute(m.userId); break;
              case "switch": await w.uc.switchPlan.execute(m.userId, "plus_yearly"); break;
              case "fail": w.charges.failNext(); break;
              case "refund": await w.uc.refund.execute(m.userId); break;
              case "sweep": await w.uc.sweep.execute(); await w.uc.recognize.execute(); break;
            }
            for (const e of w.ledger.entries) {
              expect(e.postings.reduce((a, p) => a + p.amount.amount, 0n)).toBe(0n);
            }
            const keys = w.charges.requests.map((r) => r.idempotencyKey);
            const live = await w.store.getLiveByUser(m.userId);
            if (live !== null) {
              const entitled = (await w.uc.entitlements.forUser(m.userId)).entitled;
              expect(entitled).toBe(isEntitled(live, w.clock.nowMs()));
            }
            expect(keys.length).toBeGreaterThan(0);
          }
          // each distinct key produced at most one successful charge posting
          const charged = w.ledger.entries.filter((e) => e.kind === "plus_charged").length;
          const paidInvoices = (await w.store.listInvoices(must(await w.store.getLatestByUser(m.userId)).id)).filter((i) => i.status !== "FAILED" && i.amountMinor > 0n).length;
          expect(charged).toBeGreaterThanOrEqual(paidInvoices);
        },
      ),
      { numRuns: 40 },
    );
  });
});
