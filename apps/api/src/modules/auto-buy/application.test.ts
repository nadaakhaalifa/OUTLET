import { describe, expect, it } from "vitest";
import { AutoBuyEventConsumer } from "./application/events";
import { AUTO_BUY_LIMITS } from "./domain/bridge";
import { SKU, U } from "./test/repository-contract";
import { MIN, TOKEN, createWorld, quote } from "./test/world";

const WINDOW = AUTO_BUY_LIMITS.cancelWindowMs;

describe("CreateMandate", () => {
  it("creates an explicit rule, stores the exact accepted wording and emits auto_buy.armed", async () => {
    const w = createWorld();
    const r = await w.create.execute(w.input());
    expect(r.kind).toBe("created");
    if (r.kind !== "created") return;
    expect(r.termsText).toContain("Linen dress");
    expect(r.termsText).toContain("649.00");
    expect(r.termsText).toContain("700.00");
    expect(r.mandate).toMatchObject({ status: "ARMED", mode: "notify_confirm", pspTokenRef: null, mandateVersion: 1 });
    expect(r.mandate.termsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(w.store.events.map((e) => e.type)).toEqual(["auto_buy.armed"]);
    // no PSP, no inventory and no risk charge call at creation
    expect(w.mit.placeCalls).toHaveLength(0);
    expect(w.inventory.held.size).toBe(0);
  });

  it("renders the Arabic wording for an Arabic mandate", async () => {
    const w = createWorld();
    const r = await w.create.execute(w.input({ locale: "ar" }));
    expect(r.kind === "created" && r.termsText.includes("فستان كتان")).toBe(true);
  });

  const refusals: [string, (w: ReturnType<typeof createWorld>) => void, Record<string, unknown>, string][] = [
    ["switch off", (w) => void (w.flags.rules = false), {}, "disabled"],
    ["not a Plus member", (w) => w.eligibility.byUser.set(U(1), { plusActive: false, ageOk: true }), {}, "plus_required"],
    ["under the Plus age", (w) => w.eligibility.byUser.set(U(1), { plusActive: true, ageOk: false }), {}, "age_restricted"],
    ["unknown sku", () => undefined, { skuId: SKU(77) }, "sku_unavailable"],
    ["unlisted sku", (w) => w.catalog.skus.set(SKU(1), quote({ listed: false })), {}, "sku_unavailable"],
    ["drop sku", (w) => w.catalog.skus.set(SKU(1), quote({ dropSku: true })), {}, "drop_sku_excluded"],
    ["unknown size", (w) => w.catalog.skus.set(SKU(1), quote({ sizeKnown: false })), {}, "size_invalid"],
    ["target not below current", () => undefined, { targetPrice: 80_000n }, "invalid"],
    ["max below target", () => undefined, { maxPrice: 60_000n }, "invalid"],
    ["expiry beyond 90 days", () => undefined, { expiresAtMs: Date.now() * 10 }, "invalid"],
    ["stale wording version", () => undefined, { acceptedTermsVersion: 2 }, "terms_version_stale"],
    ["risk blocks", (w) => void (w.risk.decision = "block"), {}, "risk_blocked"],
    ["unattended while the charge switch is off", () => undefined, { mode: "unattended", pspTokenRef: TOKEN }, "unattended_unavailable"],
  ];
  it.each(refusals)("refuses: %s", async (_n, setup, over, kind) => {
    const w = createWorld();
    setup(w);
    const r = await w.create.execute(w.input(over as never));
    expect(r.kind).toBe(kind);
    expect(w.store.mandatesAll).toHaveLength(0);
  });

  it("unattended needs a valid saved CARD token", async () => {
    const w = createWorld();
    w.flags.charge = true;
    for (const state of ["expired", "not_found", "not_card"] as const) {
      w.vault.tokens.set(TOKEN, state);
      const r = await w.create.execute(w.input({ mode: "unattended", pspTokenRef: TOKEN }));
      expect(r.kind).toBe("token_invalid");
    }
    w.vault.tokens.set(TOKEN, "valid");
    expect((await w.create.execute(w.input({ mode: "unattended", pspTokenRef: TOKEN }))).kind).toBe("created");
  });

  it("one active rule per item and at most five active rules per user", async () => {
    const w = createWorld();
    expect((await w.create.execute(w.input())).kind).toBe("created");
    expect((await w.create.execute(w.input())).kind).toBe("duplicate_active");
    for (let i = 2; i <= 5; i += 1) {
      w.catalog.skus.set(SKU(i), quote());
      expect((await w.create.execute(w.input({ skuId: SKU(i) }))).kind).toBe("created");
    }
    w.catalog.skus.set(SKU(6), quote());
    expect((await w.create.execute(w.input({ skuId: SKU(6) }))).kind).toBe("limit_reached");
    // another user is unaffected
    expect((await w.create.execute(w.input({ userId: U(2) }))).kind).toBe("created");
  });
});

describe("evaluator (mode A, notify and confirm)", () => {
  it("notifies once with target_reached and never reserves stock or charges", async () => {
    const w = createWorld();
    const r = await w.create.execute(w.input());
    expect(r.kind).toBe("created");
    const out = await w.handle.execute(w.priceEvent("pe-1", 64_000n));
    expect(out).toEqual({ kind: "handled", matched: 1, notified: 1, skipped: 0, ignored: 0 });
    expect(w.notices.sent.map((n) => n.kind)).toEqual(["target_reached"]);
    expect(w.notices.sent[0]?.cancelDeadlineMs).toBeNull();
    expect(w.inventory.held.size).toBe(0);
    expect(w.mit.placeCalls).toHaveLength(0);
    const a = w.store.attemptsAll[0];
    expect(a).toMatchObject({ state: "NOTIFIED", mode: "notify_confirm", reservationRef: null });
  });

  it("the same price event delivered twice creates exactly one attempt and one notice", async () => {
    const w = createWorld();
    await w.create.execute(w.input());
    await w.handle.execute(w.priceEvent("pe-1", 64_000n));
    const again = await w.handle.execute(w.priceEvent("pe-1", 64_000n));
    expect(again).toMatchObject({ kind: "handled", notified: 0 });
    expect(w.store.attemptsAll).toHaveLength(1);
    expect(w.notices.sent).toHaveLength(1);
  });

  it("a price above the target is ignored and 24h cool-down applies between attempts", async () => {
    const w = createWorld();
    await w.create.execute(w.input());
    expect(await w.handle.execute(w.priceEvent("pe-0", 70_000n))).toMatchObject({ matched: 0 });
    await w.handle.execute(w.priceEvent("pe-1", 64_000n));
    w.clock.advance(60 * MIN);
    expect(await w.handle.execute(w.priceEvent("pe-2", 63_000n))).toMatchObject({ notified: 0, ignored: 1 });
    w.clock.advance(24 * 60 * MIN);
    expect(await w.handle.execute(w.priceEvent("pe-3", 63_000n))).toMatchObject({ notified: 1 });
    expect(w.store.attemptsAll).toHaveLength(2);
  });

  it("an unverified drop still notifies (mode A) but an unattended rule is never charged", async () => {
    const w = createWorld();
    const id = await w.armUnattended();
    await w.handle.execute(w.priceEvent("pe-1", 64_000n, { verified: false }));
    expect(w.store.attemptsAll[0]).toMatchObject({ mode: "notify_confirm", state: "NOTIFIED" });
    w.clock.advance(WINDOW + MIN);
    const s = await w.sweep.execute();
    expect(s.charged).toBe(0);
    expect(w.mit.placeCalls).toHaveLength(0);
    expect(id).toBeDefined();
  });

  it("an anomaly flag routes to mode A as well", async () => {
    const w = createWorld();
    await w.armUnattended();
    await w.handle.execute(w.priceEvent("pe-1", 64_000n, { anomaly: true }));
    expect(w.store.attemptsAll[0]?.mode).toBe("notify_confirm");
    expect(w.notices.sent[0]?.kind).toBe("target_reached");
  });

  it("with the rules switch off the evaluator does nothing and stored rules stay armed", async () => {
    const w = createWorld();
    await w.create.execute(w.input());
    w.flags.rules = false;
    expect(await w.handle.execute(w.priceEvent("pe-1", 64_000n))).toEqual({ kind: "paused" });
    expect(w.store.attemptsAll).toHaveLength(0);
    expect(w.notices.sent).toHaveLength(0);
    expect(w.store.mandatesAll[0]?.status).toBe("ARMED");
    const l = await w.list.execute(U(1), 10);
    expect(l.paused).toBe(true);
  });

  it("rejects malformed events", async () => {
    const w = createWorld();
    expect(await w.handle.execute({ nope: 1 })).toEqual({ kind: "invalid" });
    expect(await w.handle.execute(w.priceEvent("pe", 1n, { sku_id: "not-a-uuid" }))).toEqual({ kind: "invalid" });
    expect(await w.handle.execute(w.priceEvent("pe", 1n, { price: { amount: "-5", currency: "EGP" } }))).toEqual({ kind: "invalid" });
  });

  it("plus lapsed: the attempt is skipped, no notice, the rule stays armed", async () => {
    const w = createWorld();
    await w.create.execute(w.input());
    w.eligibility.byUser.set(U(1), { plusActive: false, ageOk: true });
    expect(await w.handle.execute(w.priceEvent("pe-1", 64_000n))).toMatchObject({ skipped: 1, notified: 0 });
    expect(w.store.attemptsAll[0]).toMatchObject({ state: "SKIPPED", failureReason: "plus_lapsed" });
    expect(w.notices.sent).toHaveLength(0);
    expect(w.store.mandatesAll[0]?.status).toBe("ARMED");
  });

  it("a dependency failure fails closed: skipped, nothing sent", async () => {
    const w = createWorld();
    await w.create.execute(w.input());
    w.eligibility.eligibility = async () => {
      throw new Error("subscriptions down");
    };
    expect(await w.handle.execute(w.priceEvent("pe-1", 64_000n))).toMatchObject({ skipped: 1 });
    expect(w.store.attemptsAll[0]?.failureReason).toBe("dependency_unavailable");
  });
});

describe("unattended charge (mode B, behind kill.auto_buy.charge)", () => {
  it("acceptance: pre-charge notice, nothing charged before the 15 minute window ends, then one MIT charge through the saga port", async () => {
    const w = createWorld();
    const mandateId = await w.armUnattended();
    w.setLive({ price: 64_000n });
    expect(await w.handle.execute(w.priceEvent("pe-1", 64_000n))).toMatchObject({ notified: 1 });
    const n = w.notices.sent[0];
    expect(n?.kind).toBe("pre_charge");
    expect(n?.cancelDeadlineMs).toBe(w.clock.nowMs() + WINDOW);
    expect(w.inventory.held.size).toBe(1);

    w.clock.advance(WINDOW - 1);
    expect((await w.sweep.execute()).charged).toBe(0);
    expect(w.mit.placeCalls).toHaveLength(0);

    w.mit.next = { kind: "placed", orderGroupId: "00000000-0000-4000-8000-0000000000aa" };
    w.clock.advance(1);
    const s = await w.sweep.execute();
    expect(s).toMatchObject({ charged: 1, chargePaused: false });
    expect(w.mit.placeCalls).toHaveLength(1);
    const call = w.mit.placeCalls[0];
    expect(call).toMatchObject({ amount: 64_000n, tokenRef: TOKEN, userId: U(1), skuId: SKU(1) });
    expect(call?.idempotencyKey).toBe(`auto_buy:${mandateId}:pe-1`);
    expect(w.store.attemptsAll[0]).toMatchObject({ state: "PURCHASED", chargePrice: 64_000n, orderGroupId: "00000000-0000-4000-8000-0000000000aa" });
    expect(w.store.mandatesAll[0]).toMatchObject({ status: "PURCHASED", closedReason: "purchased" });
    expect(w.store.events.map((e) => e.type)).toEqual(["auto_buy.armed", "auto_buy.notified", "auto_buy.charged"]);
    expect(w.notices.sent.map((x) => x.kind)).toEqual(["pre_charge", "charged"]);
    // a second sweep cannot charge again
    await w.sweep.execute();
    expect(w.mit.placeCalls).toHaveLength(1);
  });

  it("acceptance: cancelling inside the window releases the hold and no payment is ever attempted", async () => {
    const w = createWorld();
    await w.armUnattended();
    w.setLive({ price: 64_000n });
    await w.handle.execute(w.priceEvent("pe-1", 64_000n));
    const attemptId = w.store.attemptsAll[0]?.id ?? "";
    w.clock.advance(5 * MIN);
    expect(await w.cancelAttempt.execute(U(1), attemptId)).toEqual({ kind: "cancelled" });
    expect(w.inventory.released).toContain(attemptId);
    expect(w.inventory.held.size).toBe(0);
    expect(await w.cancelAttempt.execute(U(1), attemptId)).toEqual({ kind: "already_cancelled" });
    w.clock.advance(WINDOW);
    expect((await w.sweep.execute()).charged).toBe(0);
    expect(w.mit.placeCalls).toHaveLength(0);
    expect(w.store.attemptsAll[0]?.state).toBe("CANCELLED_BY_USER");
  });

  it("acceptance: a price of 720 against max 700 at charge time never charges and the rule stays armed", async () => {
    const w = createWorld();
    await w.armUnattended();
    w.setLive({ price: 64_000n });
    await w.handle.execute(w.priceEvent("pe-1", 64_000n));
    w.setLive({ price: 72_000n });
    w.clock.advance(WINDOW);
    const s = await w.sweep.execute();
    expect(s).toMatchObject({ charged: 0, skipped: 1 });
    expect(w.mit.placeCalls).toHaveLength(0);
    expect(w.store.attemptsAll[0]).toMatchObject({ state: "SKIPPED", failureReason: "price_above_max" });
    expect(w.store.mandatesAll[0]?.status).toBe("ARMED");
    expect(w.notices.sent.at(-1)?.kind).toBe("not_charged");
    expect(w.inventory.held.size).toBe(0);
  });

  it("acceptance: with kill.auto_buy.charge off the shopper is only notified and the fake PSP sees zero calls", async () => {
    const w = createWorld();
    await w.armUnattended();
    w.flags.charge = false;
    await w.handle.execute(w.priceEvent("pe-1", 64_000n));
    expect(w.notices.sent.map((n) => n.kind)).toEqual(["target_reached"]);
    expect(w.store.attemptsAll[0]?.mode).toBe("notify_confirm");
    w.clock.advance(WINDOW * 4);
    const s = await w.sweep.execute();
    expect(s.chargePaused).toBe(true);
    expect(w.mit.placeCalls).toHaveLength(0);
    expect(w.mit.lookupCalls).toHaveLength(0);
  });

  it("the switch turned off after the notice: no charge, and the stale notice is retired with the hold released", async () => {
    const w = createWorld();
    await w.armUnattended();
    await w.handle.execute(w.priceEvent("pe-1", 64_000n));
    const id = w.store.attemptsAll[0]?.id ?? "";
    w.flags.charge = false;
    w.clock.advance(WINDOW + AUTO_BUY_LIMITS.noticeGraceMs + 1);
    await w.sweep.execute();
    expect(w.mit.placeCalls).toHaveLength(0);
    expect(w.store.attemptsAll[0]).toMatchObject({ state: "SKIPPED", failureReason: "notice_stale" });
    expect(w.inventory.released).toContain(id);
  });

  it("a late worker never charges on a stale notice, even with the switch on", async () => {
    const w = createWorld();
    await w.armUnattended();
    await w.handle.execute(w.priceEvent("pe-1", 64_000n));
    const id = w.store.attemptsAll[0]?.id ?? "";
    w.clock.advance(WINDOW + AUTO_BUY_LIMITS.noticeGraceMs + 1);
    expect(await w.sweep.charge(id)).toBe("raced");
    await w.sweep.execute();
    expect(w.mit.placeCalls).toHaveLength(0);
    expect(w.store.attemptsAll[0]?.failureReason).toBe("notice_stale");
  });

  it("no notice, no charge: a notice that was not enqueued skips the attempt and releases the hold", async () => {
    for (const result of ["failed", "throw"] as const) {
      const w = createWorld();
      await w.armUnattended();
      w.notices.result = result;
      expect(await w.handle.execute(w.priceEvent("pe-1", 64_000n))).toMatchObject({ skipped: 1, notified: 0 });
      expect(w.store.attemptsAll[0]).toMatchObject({ state: "SKIPPED", failureReason: "notice_failed" });
      expect(w.inventory.held.size).toBe(0);
      w.clock.advance(WINDOW * 2);
      await w.sweep.execute();
      expect(w.mit.placeCalls).toHaveLength(0);
    }
  });

  it("no stock to hold at the start of the window: skipped, rule stays armed, nothing notified", async () => {
    const w = createWorld();
    await w.armUnattended();
    w.inventory.available = false;
    expect(await w.handle.execute(w.priceEvent("pe-1", 64_000n))).toMatchObject({ skipped: 1 });
    expect(w.store.attemptsAll[0]?.failureReason).toBe("out_of_stock");
    expect(w.notices.sent).toHaveLength(0);
    expect(w.store.mandatesAll[0]?.status).toBe("ARMED");
  });

  const recheckFailures: [string, (w: ReturnType<typeof createWorld>) => void, string][] = [
    ["plus lapsed", (w) => w.eligibility.byUser.set(U(1), { plusActive: false, ageOk: true }), "plus_lapsed"],
    ["token expired", (w) => w.vault.tokens.set(TOKEN, "expired"), "token_invalid"],
    ["card deleted", (w) => w.vault.tokens.set(TOKEN, "not_found"), "token_invalid"],
    ["sold out", (w) => w.setLive({ price: 64_000n, sizeInStock: false }), "out_of_stock"],
    ["unlisted", (w) => w.setLive({ price: 64_000n, listed: false }), "sku_unlisted"],
    ["price no longer verified", (w) => w.setLive({ price: 64_000n, priceVerified: false }), "price_not_verified"],
    ["anomaly", (w) => w.setLive({ price: 64_000n, priceAnomaly: true }), "price_anomaly"],
    ["address not deliverable", (w) => void (w.deliverability.deliverable_ = false), "not_deliverable"],
    ["hard cap", (w) => void (w.budget.decision = "hard_cap_exceeded"), "budget_cap"],
    ["soft cap", (w) => void (w.budget.decision = "soft_cap_exceeded"), "budget_cap"],
    ["fraud decision", (w) => void (w.risk.decision = "require_otp"), "risk_not_allowed"],
  ];
  it.each(recheckFailures)("re-validation at charge time: %s means no charge", async (_n, mutate, reason) => {
    const w = createWorld();
    await w.armUnattended();
    w.setLive({ price: 64_000n });
    await w.handle.execute(w.priceEvent("pe-1", 64_000n));
    mutate(w);
    w.clock.advance(WINDOW);
    await w.sweep.execute();
    expect(w.mit.placeCalls).toHaveLength(0);
    expect(w.store.attemptsAll[0]).toMatchObject({ state: "SKIPPED", failureReason: reason });
    expect(w.store.mandatesAll[0]?.status).toBe("ARMED");
  });

  it("a dependency error at charge time is a refusal, never a charge", async () => {
    const w = createWorld();
    await w.armUnattended();
    w.setLive({ price: 64_000n });
    await w.handle.execute(w.priceEvent("pe-1", 64_000n));
    w.catalog.quote = async () => {
      throw new Error("catalog down");
    };
    w.clock.advance(WINDOW);
    await w.sweep.execute();
    expect(w.mit.placeCalls).toHaveLength(0);
    expect(w.store.attemptsAll[0]?.failureReason).toBe("dependency_unavailable");
  });

  it("a declined charge ends FAILED, releases the hold, tells the shopper and leaves the rule armed", async () => {
    const w = createWorld();
    await w.armUnattended();
    w.setLive({ price: 64_000n });
    await w.handle.execute(w.priceEvent("pe-1", 64_000n));
    w.mit.next = { kind: "declined", code: "insufficient_funds" };
    w.clock.advance(WINDOW);
    expect(await w.sweep.execute()).toMatchObject({ charged: 0, failed: 1 });
    expect(w.mit.placeCalls).toHaveLength(1);
    expect(w.store.attemptsAll[0]).toMatchObject({ state: "FAILED", failureReason: "declined:insufficient_funds" });
    expect(w.store.mandatesAll[0]?.status).toBe("ARMED");
    expect(w.inventory.held.size).toBe(0);
    expect(w.notices.sent.at(-1)?.kind).toBe("not_charged");
    // no retry storm: another sweep does not call the PSP again
    await w.sweep.execute();
    expect(w.mit.placeCalls).toHaveLength(1);
  });

  it("B-1: a throwing placeOrder is UNKNOWN: stays CHARGING, never FAILED, never a second call", async () => {
    const w = createWorld();
    await w.armUnattended();
    w.setLive({ price: 64_000n });
    await w.handle.execute(w.priceEvent("pe-1", 64_000n));
    w.mit.next = "throw";
    w.clock.advance(WINDOW);
    await w.sweep.execute();
    expect(w.store.attemptsAll[0]).toMatchObject({ state: "CHARGING" });
    expect(w.inventory.held.size).toBe(1);
    await w.sweep.execute();
    expect(w.mit.placeCalls).toHaveLength(1);
  });

  it("a PSP timeout is not a failure: the attempt stays CHARGING and is reconciled by idempotency key", async () => {
    const w = createWorld();
    await w.armUnattended();
    w.setLive({ price: 64_000n });
    await w.handle.execute(w.priceEvent("pe-1", 64_000n));
    w.mit.next = { kind: "pending" };
    w.clock.advance(WINDOW);
    await w.sweep.execute();
    expect(w.store.attemptsAll[0]?.state).toBe("CHARGING");
    // too early to reconcile
    w.clock.advance(AUTO_BUY_LIMITS.chargeUnresolvedMs - 1);
    expect((await w.sweep.execute()).reconciled).toBe(0);
    // the normal PSP webhook path created the order meanwhile
    w.mit.placed.set(w.mit.placeCalls[0]?.idempotencyKey ?? "", "00000000-0000-4000-8000-0000000000bb");
    w.clock.advance(2);
    expect((await w.sweep.execute()).reconciled).toBe(1);
    expect(w.store.attemptsAll[0]).toMatchObject({ state: "PURCHASED", orderGroupId: "00000000-0000-4000-8000-0000000000bb" });
    expect(w.mit.placeCalls).toHaveLength(1);
  });

  it("an unresolved charge with no order after the window goes to MANUAL_REVIEW (never FAILED on unknown)", async () => {
    const w = createWorld();
    await w.armUnattended();
    w.setLive({ price: 64_000n });
    await w.handle.execute(w.priceEvent("pe-1", 64_000n));
    w.mit.next = { kind: "pending" };
    w.clock.advance(WINDOW);
    await w.sweep.execute();
    w.clock.advance(AUTO_BUY_LIMITS.chargeUnresolvedMs + 1);
    await w.sweep.execute();
    expect(w.store.attemptsAll[0]).toMatchObject({ state: "MANUAL_REVIEW", failureReason: "unresolved_not_found" });
    expect(w.inventory.held.size).toBe(0);
    expect(w.store.events.map((e) => e.type)).toContain("auto_buy.manual_review");
    expect(w.store.events.map((e) => e.type)).not.toContain("auto_buy.failed");
  });

  it("SCA required parks the attempt; an SCA the PSP confirms was not charged ends FAILED", async () => {
    const w = createWorld();
    await w.armUnattended();
    w.setLive({ price: 64_000n });
    await w.handle.execute(w.priceEvent("pe-1", 64_000n));
    w.mit.next = { kind: "sca_required" };
    w.clock.advance(WINDOW);
    expect(await w.sweep.execute()).toMatchObject({ awaitingSca: 1 });
    expect(w.store.attemptsAll[0]?.state).toBe("REQUIRES_USER_ACTION");
    expect(w.notices.sent.at(-1)?.kind).toBe("sca_required");
    w.clock.advance(AUTO_BUY_LIMITS.scaAbandonMs + 1);
    w.mit.lookupAnswers.set(w.mit.placeCalls[0]?.idempotencyKey ?? "", { kind: "failed" });
    await w.sweep.execute();
    expect(w.store.attemptsAll[0]).toMatchObject({ state: "FAILED", failureReason: "psp_confirmed_not_charged" });
    expect(w.mit.placeCalls).toHaveLength(1);
  });

  it("cancel versus charge: whichever commits first wins and there is never both", async () => {
    for (const order of ["cancel-first", "charge-first", "parallel"] as const) {
      const w = createWorld();
      await w.armUnattended();
      w.setLive({ price: 64_000n });
      await w.handle.execute(w.priceEvent("pe-1", 64_000n));
      const id = w.store.attemptsAll[0]?.id ?? "";
      w.mit.next = { kind: "placed", orderGroupId: "00000000-0000-4000-8000-0000000000cc" };
      w.clock.advance(WINDOW);
      let cancelled: string;
      let charged: string;
      if (order === "cancel-first") {
        cancelled = (await w.cancelAttempt.execute(U(1), id)).kind;
        charged = await w.sweep.charge(id);
      } else if (order === "charge-first") {
        charged = await w.sweep.charge(id);
        cancelled = (await w.cancelAttempt.execute(U(1), id)).kind;
      } else {
        [cancelled, charged] = await Promise.all([w.cancelAttempt.execute(U(1), id).then((r) => r.kind), w.sweep.charge(id)]);
      }
      const state = w.store.attemptsAll[0]?.state;
      if (state === "CANCELLED_BY_USER") {
        expect(w.mit.placeCalls).toHaveLength(0);
        expect(cancelled).toBe("cancelled");
        expect(charged).toBe("raced");
      } else {
        expect(state).toBe("PURCHASED");
        expect(w.mit.placeCalls).toHaveLength(1);
        expect(cancelled).toBe("not_cancellable");
      }
    }
  });
});

describe("Phase 3 money review, part B regressions", () => {
  const charging = async (w: ReturnType<typeof createWorld>, result: unknown = { kind: "pending" }) => {
    await w.armUnattended();
    w.setLive({ price: 64_000n });
    await w.handle.execute(w.priceEvent("pe-1", 64_000n));
    w.mit.next = result as never;
    w.clock.advance(WINDOW);
    await w.sweep.execute();
    return w.mit.placeCalls[0]?.idempotencyKey ?? "";
  };
  const LATE_ORDER = "00000000-0000-4000-8000-0000000000cc";

  it("B-1: PSP slower than the reconcile window then succeeds: PURCHASED, mandate PURCHASED, no second attempt", async () => {
    const w = createWorld();
    const key = await charging(w);
    expect(w.store.attemptsAll[0]?.state).toBe("CHARGING");
    // saga still running for 20 minutes: in_progress is never a failure
    w.mit.lookupAnswers.set(key, { kind: "pending" });
    w.clock.advance(AUTO_BUY_LIMITS.chargeUnresolvedMs + 1);
    await w.sweep.execute();
    w.clock.advance(10 * MIN);
    await w.sweep.execute();
    expect(w.store.attemptsAll[0]?.state).toBe("CHARGING");
    expect(w.inventory.held.size).toBe(1);
    // the saga completes late
    w.mit.lookupAnswers.set(key, { kind: "placed", orderGroupId: LATE_ORDER });
    await w.sweep.execute();
    expect(w.store.attemptsAll[0]).toMatchObject({ state: "PURCHASED", orderGroupId: LATE_ORDER });
    expect(w.store.mandatesAll[0]?.status).toBe("PURCHASED");
    // a later verified price event under target creates no attempt and no charge
    w.clock.advance(48 * 60 * MIN);
    await w.handle.execute(w.priceEvent("pe-2", 60_000n));
    expect(w.store.attemptsAll).toHaveLength(1);
    expect(w.mit.placeCalls).toHaveLength(1);
  });

  it("B-1: placeOrder throws after the PSP recorded the key: no FAILED, no second place call, late success recorded", async () => {
    const w = createWorld();
    await w.armUnattended();
    w.setLive({ price: 64_000n });
    await w.handle.execute(w.priceEvent("pe-1", 64_000n));
    w.mit.next = "throw";
    w.clock.advance(WINDOW);
    await w.sweep.execute();
    const key = w.mit.placeCalls[0]?.idempotencyKey ?? "";
    expect(w.store.attemptsAll[0]?.state).toBe("CHARGING");
    expect(w.store.events.map((e) => e.type)).not.toContain("auto_buy.failed");
    w.mit.placed.set(key, LATE_ORDER);
    w.clock.advance(AUTO_BUY_LIMITS.chargeUnresolvedMs + 1);
    await w.sweep.execute();
    expect(w.store.attemptsAll[0]?.state).toBe("PURCHASED");
    expect(w.mit.placeCalls).toHaveLength(1);
  });

  it("B-1: lookup unreachable or not found escalates to MANUAL_REVIEW, blocks new attempts, and a late success still lands", async () => {
    const w = createWorld();
    const key = await charging(w);
    w.mit.lookupThrows = true;
    w.clock.advance(AUTO_BUY_LIMITS.chargeEscalateMs + 1);
    await w.sweep.execute();
    expect(w.store.attemptsAll[0]?.state).toBe("MANUAL_REVIEW");
    expect(w.notices.sent.some((n) => n.kind === "not_charged")).toBe(false);
    // price event after the cooldown: still no new attempt while an unresolved charge exists
    w.clock.advance(48 * 60 * MIN);
    await w.handle.execute(w.priceEvent("pe-2", 60_000n));
    expect(w.store.attemptsAll).toHaveLength(1);
    expect(w.mit.placeCalls).toHaveLength(1);
    // disarm leaves the parked attempt alone
    // PSP comes back: the order exists
    w.mit.lookupThrows = false;
    w.mit.placed.set(key, LATE_ORDER);
    await w.sweep.execute();
    expect(w.store.attemptsAll[0]).toMatchObject({ state: "PURCHASED", orderGroupId: LATE_ORDER });
    expect(w.store.mandatesAll[0]?.status).toBe("PURCHASED");
  });

  it("B-1: only a PSP-confirmed terminal failure moves a charge to FAILED", async () => {
    const w = createWorld();
    const key = await charging(w);
    w.mit.lookupAnswers.set(key, { kind: "failed" });
    w.clock.advance(AUTO_BUY_LIMITS.chargeUnresolvedMs + 1);
    await w.sweep.execute();
    expect(w.store.attemptsAll[0]).toMatchObject({ state: "FAILED", failureReason: "psp_confirmed_not_charged" });
    expect(w.inventory.held.size).toBe(0);
  });

  it("B-1/B-9: an SCA completed at the PSP after the abandon age is recorded as PURCHASED, not FAILED", async () => {
    const w = createWorld();
    const key = await charging(w, { kind: "sca_required" });
    expect(w.store.attemptsAll[0]?.state).toBe("REQUIRES_USER_ACTION");
    w.mit.placed.set(key, LATE_ORDER);
    w.clock.advance(AUTO_BUY_LIMITS.scaAbandonMs + 1);
    await w.sweep.execute();
    expect(w.store.attemptsAll[0]).toMatchObject({ state: "PURCHASED", orderGroupId: LATE_ORDER });
  });

  it("B-2: price 640 at the notice, flapped to 699 at the claim with max 700: skipped, armed, zero MIT calls", async () => {
    const w = createWorld();
    await w.armUnattended();
    w.setLive({ price: 64_000n });
    await w.handle.execute(w.priceEvent("pe-1", 64_000n));
    w.setLive({ price: 69_900n });
    w.clock.advance(WINDOW);
    expect(await w.sweep.execute()).toMatchObject({ charged: 0, skipped: 1 });
    expect(w.mit.placeCalls).toHaveLength(0);
    expect(w.store.attemptsAll[0]).toMatchObject({ state: "SKIPPED", failureReason: "price_above_notified" });
    expect(w.store.mandatesAll[0]?.status).toBe("ARMED");
  });

  it("B-2: a further drop below the notified price charges the lower amount", async () => {
    const w = createWorld();
    await w.armUnattended();
    w.setLive({ price: 64_000n });
    await w.handle.execute(w.priceEvent("pe-1", 64_000n));
    w.setLive({ price: 60_000n });
    w.mit.next = { kind: "placed", orderGroupId: LATE_ORDER };
    w.clock.advance(WINDOW);
    await w.sweep.execute();
    expect(w.mit.placeCalls[0]?.amount).toBe(60_000n);
  });

  it("B-5: the charge window ends no later than the stock hold: a charge never runs on an expired hold", () => {
    expect(WINDOW + AUTO_BUY_LIMITS.noticeGraceMs).toBeLessThanOrEqual(WINDOW + AUTO_BUY_LIMITS.reservationPaymentMs);
  });

  it("B-6: a skipped attempt (dependency outage) does not start the 24h cooldown", async () => {
    const w = createWorld();
    await w.create.execute(w.input());
    w.eligibility.byUser.set(U(1), { plusActive: false, ageOk: true });
    await w.handle.execute(w.priceEvent("pe-1", 64_000n));
    expect(w.store.attemptsAll[0]?.state).toBe("SKIPPED");
    w.eligibility.byUser.set(U(1), { plusActive: true, ageOk: true });
    w.clock.advance(5 * MIN);
    expect(await w.handle.execute(w.priceEvent("pe-2", 63_000n))).toMatchObject({ notified: 1 });
  });

  it("B-7: concurrent creates for different SKUs cannot exceed five active rules", async () => {
    const w = createWorld();
    for (let i = 1; i <= 8; i += 1) w.catalog.skus.set(SKU(i), quote());
    const results = await Promise.all(
      [1, 2, 3, 4, 5, 6, 7, 8].map((i) => w.create.execute(w.input({ skuId: SKU(i) }))),
    );
    expect(results.filter((r) => r.kind === "created")).toHaveLength(5);
    expect(w.store.mandatesAll.filter((m) => m.status === "ARMED")).toHaveLength(5);
  });

  it("B-8: the cancel window is measured from after the notice was enqueued", async () => {
    const w = createWorld();
    await w.armUnattended();
    const slow = w.notices.send.bind(w.notices);
    w.notices.send = async (n) => {
      w.clock.advance(4 * MIN); // slow notification queue
      return slow(n);
    };
    await w.handle.execute(w.priceEvent("pe-1", 64_000n));
    const a = w.store.attemptsAll[0];
    expect(a?.noticeSentAtMs).not.toBeNull();
    expect((a?.cancelDeadlineMs ?? 0) - (a?.noticeSentAtMs ?? 0)).toBeGreaterThanOrEqual(WINDOW);
  });
});

describe("cancel, close and lifecycle", () => {
  it("only the owner can cancel a rule or an attempt: foreign and missing ids are the same answer", async () => {
    const w = createWorld();
    const id = await w.armUnattended();
    await w.handle.execute(w.priceEvent("pe-1", 64_000n));
    const attemptId = w.store.attemptsAll[0]?.id ?? "";
    expect(await w.cancelRule.execute(U(2), id)).toEqual({ kind: "not_found" });
    expect(await w.cancelRule.execute(U(1), "00000000-0000-4000-8000-0000000000ff")).toEqual({ kind: "not_found" });
    expect(await w.cancelAttempt.execute(U(2), attemptId)).toEqual({ kind: "not_found" });
    expect(w.store.attemptsAll[0]?.state).toBe("NOTIFIED");
    expect(w.store.mandatesAll[0]?.status).toBe("ARMED");
  });

  it("cancelling a rule disarms it, disarms the open attempt and releases the hold; repeat is idempotent", async () => {
    const w = createWorld();
    const id = await w.armUnattended();
    await w.handle.execute(w.priceEvent("pe-1", 64_000n));
    expect(await w.cancelRule.execute(U(1), id)).toEqual({ kind: "cancelled" });
    expect(w.store.attemptsAll[0]?.state).toBe("DISARMED");
    expect(w.inventory.held.size).toBe(0);
    expect(await w.cancelRule.execute(U(1), id)).toEqual({ kind: "already_cancelled" });
    w.clock.advance(WINDOW);
    await w.sweep.execute();
    expect(w.mit.placeCalls).toHaveLength(0);
    // a new rule for the same item may now be created
    expect((await w.create.execute(w.input())).kind).toBe("created");
  });

  it("a purchased rule cannot be cancelled as a rule", async () => {
    const w = createWorld();
    const id = await w.armUnattended();
    w.setLive({ price: 64_000n });
    await w.handle.execute(w.priceEvent("pe-1", 64_000n));
    w.mit.next = { kind: "placed", orderGroupId: "00000000-0000-4000-8000-0000000000dd" };
    w.clock.advance(WINDOW);
    await w.sweep.execute();
    expect(await w.cancelRule.execute(U(1), id)).toEqual({ kind: "closed", status: "PURCHASED" });
  });

  it("expiry closes the rule and its open attempts and releases holds", async () => {
    const w = createWorld();
    await w.armUnattended({ expiresAtMs: w.clock.nowMs() + 20 * MIN });
    await w.handle.execute(w.priceEvent("pe-1", 64_000n));
    w.clock.advance(21 * MIN);
    expect((await w.sweep.execute()).expired).toBe(1);
    expect(w.store.mandatesAll[0]).toMatchObject({ status: "EXPIRED", closedReason: "expired" });
    expect(w.store.attemptsAll[0]?.state).toBe("DISARMED");
    expect(w.inventory.held.size).toBe(0);
    expect(w.mit.placeCalls).toHaveLength(0);
  });

  it("buying the item through normal checkout closes the rule", async () => {
    const w = createWorld();
    await w.create.execute(w.input());
    await w.handle.execute(w.priceEvent("pe-1", 64_000n));
    expect(await w.closeOnPurchase.execute(U(1), SKU(1))).toBe(1);
    expect(w.store.mandatesAll[0]).toMatchObject({ status: "DISARMED", closedReason: "purchased_via_checkout" });
    expect(await w.closeOnPurchase.execute(U(1), SKU(1))).toBe(0);
  });

  it("removing a card or deleting the account cancels the matching rules", async () => {
    const w = createWorld();
    await w.armUnattended();
    w.catalog.skus.set(SKU(2), quote());
    await w.create.execute(w.input({ skuId: SKU(2) }));
    expect(await w.cancelAll.execute(U(1), "card_removed", TOKEN)).toBe(1);
    expect(w.store.mandatesAll.filter((m) => m.status === "ARMED")).toHaveLength(1);
    expect(await w.cancelAll.execute(U(1), "account_deleted")).toBe(1);
    expect(w.store.mandatesAll.every((m) => m.status === "DISARMED")).toBe(true);
  });

  it("a hold release failure is a delay, not an error (TTL backstop)", async () => {
    const w = createWorld();
    const id = await w.armUnattended();
    await w.handle.execute(w.priceEvent("pe-1", 64_000n));
    w.inventory.throwOnRelease = true;
    await expect(w.cancelRule.execute(U(1), id)).resolves.toEqual({ kind: "cancelled" });
  });
});

describe("B-4: relay consumer", () => {
  it("price.changed drives the evaluator; deletion cancels every rule; bad payloads are invalid, unknown types ignored", async () => {
    const w = createWorld();
    const c = new AutoBuyEventConsumer(w.handle, w.cancelAll);
    await w.create.execute(w.input());
    expect(await c.handle({ messageId: "m1", type: "price.changed", payload: w.priceEvent("pe-1", 64_000n) })).toBe("handled");
    expect(w.store.attemptsAll).toHaveLength(1);
    // redelivery of the same message creates nothing new
    await c.handle({ messageId: "m1", type: "price.changed", payload: w.priceEvent("pe-1", 64_000n) });
    expect(w.store.attemptsAll).toHaveLength(1);
    expect(await c.handle({ messageId: "m2", type: "price.changed", payload: { nope: true } })).toBe("invalid");
    expect(await c.handle({ messageId: "m3", type: "order_group.paid", payload: {} })).toBe("ignored");
    expect(await c.handle({ messageId: "m4", type: "privacy.deletion_completed", payload: { user_id: "x" } })).toBe("invalid");
    expect(await c.handle({ messageId: "m5", type: "privacy.deletion_completed", payload: { user_id: U(1) } })).toBe("handled");
    expect(w.store.mandatesAll[0]).toMatchObject({ status: "DISARMED", closedReason: "account_deleted" });
  });
});

describe("B-4: order and card-removal events", () => {
  it("order_group.paid closes the standing rule for the bought SKU once; redelivery and other users change nothing", async () => {
    const w = createWorld();
    const c = new AutoBuyEventConsumer(w.handle, w.cancelAll, w.closeOnPurchase);
    await w.create.execute(w.input());
    const evt = (userId: string, skus: string | undefined) => ({
      messageId: "m-paid",
      type: "order_group.paid",
      payload: { user_id: userId, method: "card", total: "64000", ...(skus === undefined ? {} : { sku_ids: skus }) },
    });
    // another shopper bought it: untouched
    expect(await c.handle(evt(U(2), SKU(1)))).toBe("handled");
    expect(w.store.mandatesAll[0]?.status).toBe("ARMED");
    // an order from before the payload extension carries no SKU ids: acknowledged, nothing closed
    expect(await c.handle(evt(U(1), undefined))).toBe("ignored");
    expect(w.store.mandatesAll[0]?.status).toBe("ARMED");
    expect(await c.handle(evt(U(1), `${SKU(1)},not-a-uuid`))).toBe("handled");
    expect(w.store.mandatesAll[0]).toMatchObject({ status: "DISARMED", closedReason: "purchased_via_checkout" });
    // redelivery: the rule is already closed, nothing else moves
    expect(await c.handle(evt(U(1), SKU(1)))).toBe("handled");
    expect(w.store.mandatesAll.filter((m) => m.status === "ARMED")).toHaveLength(0);
    expect(await c.handle({ messageId: "m-bad", type: "order_group.paid", payload: {} })).toBe("invalid");
  });

  it("payment_method.removed cancels every armed rule of that user once, with the card_removed reason", async () => {
    const w = createWorld();
    const c = new AutoBuyEventConsumer(w.handle, w.cancelAll, w.closeOnPurchase);
    await w.create.execute(w.input());
    const evt = { messageId: "m-card", type: "payment_method.removed", payload: { card_id: "card-1", user_id: U(1), provider: "paymob" } };
    expect(await c.handle({ ...evt, payload: { card_id: "card-1" } })).toBe("invalid");
    expect(w.store.mandatesAll[0]?.status).toBe("ARMED");
    expect(await c.handle(evt)).toBe("handled");
    expect(w.store.mandatesAll[0]).toMatchObject({ status: "DISARMED", closedReason: "card_removed" });
    expect(await c.handle(evt)).toBe("handled");
    expect(w.store.mandatesAll.filter((m) => m.status === "ARMED")).toHaveLength(0);
  });
});
