import { describe, expect, it } from "vitest";
import { PlaceCheckout, type CommitInput } from "../application/commit";
import { HandlePaymentWebhook } from "../application/payment-events";
import { CancelCheckout, ConfirmCodOrder, RecoverSagas } from "../application/lifecycle";
import { SagaRunner } from "../application/saga-runner";
import { money } from "../domain/bridge";
import { ADDRESS, OTHER_SHOPPER, SHOPPER, SKU_1, SKU_2, createWorld, type World } from "./world";
import { bagLine, STORE_A, LINE_1, defaultBag } from "./world";

const input = (over: Partial<CommitInput> = {}): CommitInput => ({
  userId: SHOPPER,
  deviceId: "dev-1",
  idempotencyKey: "key-1",
  method: "card",
  addressId: ADDRESS,
  codes: [],
  useStoreCredit: false,
  priceLock: null,
  expectedTotal: null,
  appAttestAssertion: null,
  ...over,
});

const commit = (w: World, over: Partial<CommitInput> = {}) => new PlaceCheckout(w.ctx).execute(input(over));
const pay = async (w: World, groupId: string, intentId: string, kind: "succeeded" | "failed" = "succeeded", amount?: bigint, eventId = `evt-${groupId}-${kind}`) => {
  if (kind === "succeeded") w.provider.markSucceeded(intentId);
  const rec = await w.repo.get(groupId);
  const e = w.provider.webhook({
    eventId,
    intentId,
    orderGroupId: groupId,
    kind,
    amount: amount ?? rec?.facts.externalDue ?? 0n,
  });
  return new HandlePaymentWebhook(w.ctx).execute({ provider: "fake-psp", rawBody: e.rawBody, headers: e.headers });
};

describe("checkout saga (fakes)", () => {
  it("card: reserves, creates one intent keyed by the order group, waits; webhook places the order and posts a balanced ledger entry", async () => {
    const w = createWorld();
    const r = await commit(w);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.state).toBe("pending");
    expect(r.clientAction.type).toBe("redirect");
    const g = r.record.orderGroupId;
    expect(r.record.facts.status).toBe("AWAIT_PAYMENT");
    expect(r.record.stored.quote.total.amount).toBe(238_000n);
    expect([...w.provider.intents.keys()]).toEqual([`pi_${g}`]);
    expect(w.inventory.activeReservations()).toBe(1);

    expect((await pay(w, g, `pi_${g}`)).kind).toBe("applied");
    const done = await w.repo.get(g);
    expect(done?.facts.status).toBe("PLACED");
    expect(w.orders.placed.get(g)?.sellerOrders).toHaveLength(2);
    expect(w.ledger.trialBalance()).toBe(0n);
    expect(w.ledger.balance("psp_clearing:fake-psp")).toBe(238_000n);
    expect(w.inventory.claimedGroups()).toBe(1);
    expect(w.cart.removed).toHaveLength(1);
  });

  it("order_group.paid carries the additive fields for creators and auto-buy, once, with the original fields intact", async () => {
    const w = createWorld();
    const r = await commit(w);
    if (r.kind !== "ok") throw new Error("expected ok");
    const g = r.record.orderGroupId;
    await pay(w, g, `pi_${g}`);
    await pay(w, g, `pi_${g}`); // webhook replay
    const repo = w.repo as unknown as { outbox: { type: string; aggregateId: string; payload: Record<string, unknown> }[] };
    const paid = repo.outbox.filter((e) => e.type === "order_group.paid");
    expect(paid).toHaveLength(1);
    const e = paid[0];
    expect(e?.aggregateId).toBe(g);
    // existing fields unchanged
    expect(e?.payload).toMatchObject({ user_id: SHOPPER, method: "card", total: "238000" });
    // additive fields
    const skus = String(e?.payload["sku_ids"]).split(",");
    expect(skus.length).toBeGreaterThan(0);
    expect(skus).toEqual([...skus].sort());
    expect(new Set(skus)).toEqual(new Set((await w.repo.get(g))?.stored.lines.map((l) => l.skuId)));
    expect(e?.payload["order_group_id"]).toBe(g);
    expect(typeof e?.payload["paid_at_ms"]).toBe("number");
  });

  it("duplicate taps (same key) and a second key for the same bag give one OrderGroup and one intent", async () => {
    const w = createWorld();
    const a = await commit(w);
    const b = await commit(w);
    const c = await commit(w, { idempotencyKey: "key-2" });
    if (a.kind !== "ok" || b.kind !== "ok" || c.kind !== "ok") throw new Error("expected ok");
    expect(b.record.orderGroupId).toBe(a.record.orderGroupId);
    expect(c.record.orderGroupId).toBe(a.record.orderGroupId);
    expect(w.provider.createIntentCalls).toBe(1);
    expect(w.inventory.activeReservations()).toBe(1);
  });

  it("same key with a different body is key_reuse (422 at the edge)", async () => {
    const w = createWorld();
    await commit(w);
    expect((await commit(w, { method: "apple_pay" })).kind).toBe("key_reuse");
  });

  it("webhook before the redirect returns, then replayed, is applied once", async () => {
    const w = createWorld();
    const r = await commit(w);
    if (r.kind !== "ok") throw new Error("x");
    const g = r.record.orderGroupId;
    expect((await pay(w, g, `pi_${g}`, "succeeded", undefined, "e1")).kind).toBe("applied");
    expect((await pay(w, g, `pi_${g}`, "succeeded", undefined, "e1")).kind).toBe("duplicate");
    expect((await pay(w, g, `pi_${g}`, "succeeded", undefined, "e2")).kind).toBe("ignored");
    expect(w.orders.placed.size).toBe(1);
    expect(w.provider.succeededCount()).toBe(1);
  });

  it("webhook amount mismatch is recorded as rejected, never advances the saga, and raises the counter", async () => {
    const w = createWorld();
    const r = await commit(w);
    if (r.kind !== "ok") throw new Error("x");
    const g = r.record.orderGroupId;
    const res = await pay(w, g, `pi_${g}`, "succeeded", 1n);
    expect(res).toEqual({ kind: "rejected", reason: "amount_mismatch" });
    expect((await w.repo.get(g))?.facts.status).toBe("AWAIT_PAYMENT");
    expect(w.metrics.count("checkout_amount_mismatch_total")).toBe(1);
  });

  it("bad signature and unknown group are not oracles", async () => {
    const w = createWorld();
    const h = new HandlePaymentWebhook(w.ctx);
    const e = w.provider.webhook({ eventId: "x", intentId: "pi_z", orderGroupId: "00000000-0000-4000-8000-0000000000ff", kind: "succeeded", amount: 1n });
    expect(await h.execute({ provider: "fake-psp", rawBody: e.rawBody, headers: { "x-fake-signature": "no" } })).toEqual({ kind: "rejected", reason: "bad_signature" });
    expect((await h.execute({ provider: "fake-psp", rawBody: e.rawBody, headers: e.headers })).kind).toBe("unknown_group");
  });

  it("payment failed compensates: intent voided, reservation and credit hold released, FAILED", async () => {
    const w = createWorld();
    w.credit.setBalances(SHOPPER, [{ sub: { kind: "goodwill" } as never, balance: money(50_000n), expiresAt: null }]);
    const r = await commit(w, { useStoreCredit: true });
    if (r.kind !== "ok") throw new Error("x");
    const g = r.record.orderGroupId;
    expect(r.record.facts.holdId).not.toBeNull();
    await pay(w, g, `pi_${g}`, "failed");
    const rec = await w.repo.get(g);
    expect(rec?.facts.status).toBe("FAILED");
    expect(w.inventory.activeReservations()).toBe(0);
    expect(w.credit.leaked()).toBe(0);
    expect(w.provider.intents.get(`pi_${g}`)?.state).toBe("voided");
    expect(w.orders.placed.size).toBe(0);
  });

  it("split tender: store credit plus one external method; hold captured at placement", async () => {
    const w = createWorld();
    w.credit.setBalances(SHOPPER, [{ sub: { kind: "goodwill" } as never, balance: money(50_000n), expiresAt: null }]);
    const r = await commit(w, { useStoreCredit: true });
    if (r.kind !== "ok") throw new Error("x");
    const g = r.record.orderGroupId;
    expect(r.record.facts.creditAmount).toBe(50_000n);
    expect(r.record.facts.externalDue).toBe(188_000n);
    await pay(w, g, `pi_${g}`);
    expect((await w.repo.get(g))?.facts.status).toBe("PLACED");
    expect(w.credit.captured()).toBe(1);
    expect(w.ledger.trialBalance()).toBe(0n);
  });

  it("fully covered by store credit creates no intent", async () => {
    const w = createWorld();
    w.credit.setBalances(SHOPPER, [{ sub: { kind: "goodwill" } as never, balance: money(900_000n), expiresAt: null }]);
    const r = await commit(w, { useStoreCredit: true });
    if (r.kind !== "ok") throw new Error("x");
    expect(r.state).toBe("placed");
    expect(w.provider.createIntentCalls).toBe(0);
  });

  it("COD (allow) skips the intent, posts nothing at checkout, and places as COD immediately", async () => {
    const w = createWorld();
    const r = await commit(w, { method: "cod" });
    if (r.kind !== "ok") throw new Error("x");
    expect(r.state).toBe("placed");
    expect(w.provider.createIntentCalls).toBe(0);
    expect(w.ledger.entries.size).toBe(0);
    expect(w.orders.placed.get(r.record.orderGroupId)?.paymentMethod).toBe("cod");
  });

  it("COD requiring confirmation waits for ConfirmCodOrder; declining releases the reservation", async () => {
    const w = createWorld();
    w.risk.decision = { kind: "require_confirmation" };
    const r = await commit(w, { method: "cod" });
    if (r.kind !== "ok") throw new Error("x");
    expect(r.state).toBe("awaiting_confirmation");
    const g = r.record.orderGroupId;
    const other = await new ConfirmCodOrder(w.ctx).execute({ orderGroupId: g, userId: OTHER_SHOPPER, confirmed: true });
    expect(other.kind).toBe("not_found");
    const ok = await new ConfirmCodOrder(w.ctx).execute({ orderGroupId: g, userId: SHOPPER, confirmed: true });
    expect(ok.kind === "ok" && ok.record.facts.status).toBe("PLACED");

    const w2 = createWorld();
    w2.risk.decision = { kind: "require_confirmation" };
    const r2 = await commit(w2, { method: "cod" });
    if (r2.kind !== "ok") throw new Error("x");
    const no = await new ConfirmCodOrder(w2.ctx).execute({ orderGroupId: r2.record.orderGroupId, userId: SHOPPER, confirmed: false });
    expect(no.kind === "ok" && no.record.facts.status).toBe("CANCELLED");
    expect(w2.inventory.activeReservations()).toBe(0);
  });

  it("COD blocked, prepaid-only and over-limit make COD unavailable with a typed reason", async () => {
    for (const [decision, reason] of [
      [{ kind: "block" }, "risk_blocked"],
      [{ kind: "prepaid_only" }, "prepaid_only"],
      [{ kind: "require_prepayment" }, "prepayment_required"],
      [{ kind: "limit_value", maxAmount: money(1_000n) }, "over_cod_limit"],
    ] as const) {
      const w = createWorld();
      w.risk.decision = decision;
      const r = await commit(w, { method: "cod" });
      expect(r).toEqual({ kind: "method_unavailable", reason });
      expect(w.inventory.activeReservations()).toBe(0);
    }
  });

  it("insufficient stock at reserve: 409 shape with shortfalls, nothing held", async () => {
    const w = createWorld();
    w.inventory.setStock(SKU_2, 0);
    const r = await commit(w);
    expect(r.kind).toBe("insufficient_stock");
    if (r.kind === "insufficient_stock") expect(r.shortfalls).toEqual([{ skuId: SKU_2, requested: 1, available: 0 }]);
    expect(w.inventory.activeReservations()).toBe(0);
    expect(w.provider.createIntentCalls).toBe(0);
  });

  it("payment succeeded after the reservation expired: auto-claim when stock remains", async () => {
    const w = createWorld();
    const r = await commit(w);
    if (r.kind !== "ok") throw new Error("x");
    const g = r.record.orderGroupId;
    w.clock.advance(11 * 60_000);
    await new RecoverSagas(w.ctx).execute();
    expect((await w.repo.get(g))?.facts.status).toBe("EXPIRED");
    expect(w.provider.intents.get(`pi_${g}`)?.state).toBe("voided");
    // The PSP completed the payment anyway (race with the void).
    w.provider.intents.get(`pi_${g}`)!.state = "open";
    await pay(w, g, `pi_${g}`);
    expect((await w.repo.get(g))?.facts.status).toBe("PLACED");
    expect(w.inventory.oversold()).toBe(false);
    expect(w.metrics.count("checkout_late_payment_refund_total")).toBe(0);
  });

  it("payment succeeded after expiry and stock gone: refunded, apology voucher intent, alert counter, ledger balanced", async () => {
    const w = createWorld();
    const r = await commit(w);
    if (r.kind !== "ok") throw new Error("x");
    const g = r.record.orderGroupId;
    w.clock.advance(11 * 60_000);
    await new RecoverSagas(w.ctx).execute();
    w.inventory.takeStock(SKU_1, 5);
    w.provider.intents.get(`pi_${g}`)!.state = "open";
    await pay(w, g, `pi_${g}`);
    const rec = await w.repo.get(g);
    expect(rec?.facts.status).toBe("REFUNDED");
    expect(w.provider.netCharged()).toBe(0n);
    expect(w.metrics.count("checkout_late_payment_refund_total")).toBe(1);
    const repo = w.repo as unknown as { outbox: { type: string }[] };
    expect(repo.outbox.map((e) => e.type)).toContain("checkout.apology_voucher_requested");
    expect(w.ledger.trialBalance()).toBe(0n);
    expect(w.ledger.balance("psp_clearing:fake-psp")).toBe(0n);
    expect(w.orders.placed.size).toBe(0);
  });

  it("payment after the shopper cancelled is refunded, never placed", async () => {
    const w = createWorld();
    const r = await commit(w);
    if (r.kind !== "ok") throw new Error("x");
    const g = r.record.orderGroupId;
    const c = await new CancelCheckout(w.ctx).execute({ orderGroupId: g, userId: SHOPPER });
    expect(c.kind === "ok" && c.record.facts.status).toBe("CANCELLED");
    w.provider.intents.get(`pi_${g}`)!.state = "open";
    await pay(w, g, `pi_${g}`);
    expect((await w.repo.get(g))?.facts.status).toBe("REFUNDED");
    expect(w.provider.netCharged()).toBe(0n);
    expect(w.orders.placed.size).toBe(0);
    expect((await new CancelCheckout(w.ctx).execute({ orderGroupId: g, userId: OTHER_SHOPPER })).kind).toBe("not_found");
  });

  it("a port that keeps failing parks the saga as stuck with an event, never dropped", async () => {
    const w = createWorld();
    const r = await commit(w);
    if (r.kind !== "ok") throw new Error("x");
    const g = r.record.orderGroupId;
    w.provider.markSucceeded(`pi_${g}`);
    const bad = { ...w.ctx, orders: { place: async () => Promise.reject(new Error("orders down")) } };
    const runner = new SagaRunner(bad);
    const e = w.provider.webhook({ eventId: "s1", intentId: `pi_${g}`, orderGroupId: g, kind: "succeeded", amount: 188_000n + 50_000n });
    await new HandlePaymentWebhook(bad).execute({ provider: "fake-psp", rawBody: e.rawBody, headers: e.headers });
    for (let i = 0; i < 10; i += 1) {
      w.clock.advance(301_000);
      await runner.drive(g);
    }
    const rec = await w.repo.get(g);
    expect(rec?.stuck).toBe(true);
    expect(w.metrics.count("checkout_saga_stuck_total")).toBe(1);
    expect(w.provider.netCharged()).toBe(238_000n); // money kept, ops alerted, not refunded blindly
  });
});

describe("quote", () => {
  it("is pure: no writes to repo, inventory, credit, ledger or provider", async () => {
    const w = createWorld();
    const { QuoteCheckout } = await import("../application/quote");
    const q = await new QuoteCheckout(w.ctx).execute({ userId: SHOPPER, deviceId: null, method: "card", addressId: ADDRESS, codes: [], useStoreCredit: false, priceLock: null });
    expect(q.kind).toBe("ok");
    expect(await w.repo.findByKey(SHOPPER, "key-1")).toBeNull();
    expect(w.inventory.activeReservations()).toBe(0);
    expect(w.provider.createIntentCalls).toBe(0);
    expect(w.ledger.entries.size).toBe(0);
  });

  it("free delivery: threshold after item discounts, Plus waives, fees visible on first render", async () => {
    const { QuoteCheckout } = await import("../application/quote");
    const w = createWorld();
    w.cart.set(SHOPPER, {
      ...defaultBag(),
      lines: [bagLine({ lineId: LINE_1, skuId: SKU_1, storeId: STORE_A, price: 195_000n }), bagLine({ lineId: "00000000-0000-4000-8000-000000000699", skuId: SKU_2, storeId: STORE_A, price: 6_000n })],
    });
    const q = await new QuoteCheckout(w.ctx).execute({ userId: SHOPPER, deviceId: null, method: "card", addressId: ADDRESS, codes: [], useStoreCredit: false, priceLock: null });
    if (q.kind !== "ok") throw new Error("x");
    expect(q.quote.stores[0]?.shipping.amount).toBe(0n);
    expect(q.quote.stores[0]?.freeDeliveryReason).toBe("threshold");

    const w2 = createWorld({ plus: true });
    const q2 = await new QuoteCheckout(w2.ctx).execute({ userId: SHOPPER, deviceId: null, method: "card", addressId: ADDRESS, codes: [], useStoreCredit: false, priceLock: null });
    if (q2.kind !== "ok") throw new Error("x");
    expect(q2.quote.shipping.amount).toBe(0n);
    expect(q2.quote.stores.every((s) => s.freeDeliveryReason === "plus" && s.deliveryFee.amount === 4_000n)).toBe(true);

    const q3 = await new QuoteCheckout(createWorld().ctx).execute({ userId: SHOPPER, deviceId: null, method: "card", addressId: ADDRESS, codes: [], useStoreCredit: false, priceLock: null });
    if (q3.kind !== "ok") throw new Error("x");
    expect(q3.quote.stores.map((s) => s.deliveryFee.amount)).toEqual([4_000n, 4_000n]);
  });

  it("method gates: kill switch, drop SKUs exclude Fawry, BNPL age gate names the provider", async () => {
    const { QuoteCheckout } = await import("../application/quote");
    const w = createWorld();
    w.killSwitch.disabled.add("instapay");
    w.agePolicy.blocked.add("bnpl");
    const bag = defaultBag();
    w.cart.set(SHOPPER, { ...bag, lines: [bagLine({ lineId: LINE_1, skuId: SKU_1, storeId: STORE_A, price: 150_000n, isDrop: true })] });
    const q = await new QuoteCheckout(w.ctx).execute({ userId: SHOPPER, deviceId: null, method: "card", addressId: ADDRESS, codes: [], useStoreCredit: false, priceLock: null });
    if (q.kind !== "ok") throw new Error("x");
    const by = new Map(q.methods.map((m) => [m.method, m]));
    expect(by.get("instapay")).toMatchObject({ available: false, reason: "disabled" });
    expect(by.get("fawry")).toMatchObject({ available: false, reason: "drop_items" });
    expect(by.get("bnpl")).toMatchObject({ available: false, reason: "age_restricted", provider: "fake-bnpl" });
  });

  it("price lock: a price rise inside the window is not charged; after expiry the current price applies; a changed total needs re-confirmation", async () => {
    const { QuoteCheckout } = await import("../application/quote");
    const w = createWorld();
    const q = new QuoteCheckout(w.ctx);
    const first = await q.execute({ userId: SHOPPER, deviceId: null, method: "card", addressId: ADDRESS, codes: [], useStoreCredit: false, priceLock: null });
    if (first.kind !== "ok") throw new Error("x");
    const bag = defaultBag();
    w.cart.set(SHOPPER, { ...bag, lines: bag.lines.map((l) => ({ ...l, unitPrice: money(l.unitPrice.amount + 10_000n) })) });
    const inside = await q.execute({ userId: SHOPPER, deviceId: null, method: "card", addressId: ADDRESS, codes: [], useStoreCredit: false, priceLock: first.lockToken });
    if (inside.kind !== "ok") throw new Error("x");
    expect(inside.quote.total.amount).toBe(first.quote.total.amount);
    expect(inside.lockApplied).toBe(true);
    // Someone else's token, a forged token: ignored.
    const forged = await q.execute({ userId: SHOPPER, deviceId: null, method: "card", addressId: ADDRESS, codes: [], useStoreCredit: false, priceLock: `${first.lockToken}x` });
    if (forged.kind !== "ok") throw new Error("x");
    expect(forged.quote.total.amount).toBe(first.quote.total.amount + 20_000n);
    w.clock.advance(10 * 60_000 + 1);
    const after = await q.execute({ userId: SHOPPER, deviceId: null, method: "card", addressId: ADDRESS, codes: [], useStoreCredit: false, priceLock: first.lockToken });
    if (after.kind !== "ok") throw new Error("x");
    expect(after.quote.total.amount).toBe(first.quote.total.amount + 20_000n);

    const changed = await commit(w, { expectedTotal: first.quote.total.amount });
    expect(changed.kind).toBe("price_changed");
    if (changed.kind === "price_changed") expect(changed.delta).toBe(20_000n);
  });

  it("App Attest is required on commit when the flag is on", async () => {
    const w = createWorld({ requireAppAttest: true });
    expect((await commit(w)).kind).toBe("app_attest_required");
    expect((await commit(w, { appAttestAssertion: "valid-assertion" })).kind).toBe("ok");
  });
});
