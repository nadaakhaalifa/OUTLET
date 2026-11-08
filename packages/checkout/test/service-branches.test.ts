import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Ledger, accountCode } from "@outlet/ledger";
import { money } from "@outlet/money";
import { OutboxWriter, pgTransactionalWriter } from "@outlet/outbox";
import { InMemoryTaxRateProvider } from "@outlet/tax";
import { CheckoutError, LateRefundConsumer, PgStoreCredit, WebhookProcessor } from "../src/index.js";
import type { CheckoutErrorCode } from "../src/index.js";
import { eachStoreContext } from "../src/application/context.js";
import { makeEnv } from "../src/application/env.js";
import type { CommonDeps } from "../src/application/env.js";
import { SellerNetError } from "../src/domain/errors.js";
import { FakeBilling, FakeCipher, FakeTaxCategories, HmacQuoteTokens, defaultConfig } from "../src/testing.js";
import { createTestClient } from "@outlet/db/testing";
import { buildWorld, intentOf, paidWebhook, quoteAndPlace } from "./fixtures.js";
import type { World } from "./fixtures.js";

let w: World;
beforeAll(async () => { w = await buildWorld(); });
afterAll(async () => { await w.close(); });

const enc = new TextEncoder();
/** Delivers the group's late-refund outbox event to a LateRefundConsumer (C4: the event is the single owner of the refund request). */
const lateRefundEvent = async (groupId: string): Promise<{ id: string; payload: Record<string, unknown> }> => {
  const row = (await w.raw.query<{ id: string; payload: Record<string, unknown> }>("SELECT id, payload FROM outbox_events WHERE event_type = 'order_group.late_payment_refund' AND payload ->> 'order_group_id' = $1", [groupId])).rows[0];
  if (row === undefined) throw new Error("no late refund event");
  return row;
};
const rawStatus = async (eventId: string): Promise<{ processing_status: string; failure_reason: string | null }> =>
  (await w.raw.query<{ processing_status: string; failure_reason: string | null }>("SELECT processing_status, failure_reason FROM payment_events_raw WHERE provider_event_id = $1", [eventId])).rows[0] ?? { processing_status: "missing", failure_reason: null };
const groupStatus = async (id: string): Promise<string> => (await w.raw.query<{ status: string }>("SELECT status FROM order_groups WHERE id = $1", [id])).rows[0]?.status ?? "";
const place = async (storeIdx: 0 | 1 | 2, price: bigint, stock: number, credit?: bigint) => {
  const sku = await w.seedSku(w.stores[storeIdx], price, stock);
  const u = await w.newUser();
  if (credit !== undefined) await w.grantCredit(u, credit);
  await w.fillBag(u, [{ sku, qty: 1 }]);
  const r = await (await quoteAndPlace(w, u, "card", credit === undefined ? {} : { creditRequested: money(credit, "EGP") })).place();
  return { sku, u, r, intent: await intentOf(w, r.orderGroupId) };
};
const lapse = async (groupId: string): Promise<void> => {
  await w.raw.query("UPDATE order_groups SET payment_expires_at = now() - interval '1 minute' WHERE id = $1", [groupId]);
  await w.sweeper.run();
  w.clock.t += 11 * 60_000;
  await w.reservations.sweepExpired(new Date(w.clock.t));
};
const signedRaw = (body: object | string) => {
  const rawBody = enc.encode(typeof body === "string" ? body : JSON.stringify(body));
  return { rawBody, headers: { "x-fake-signature": w.fakes.provider.sign(rawBody) }, query: {}, receivedAt: new Date() };
};
const workerWith = (over: Partial<CommonDeps> & { cipher?: FakeCipher | { encrypt: () => Promise<Uint8Array> } }) =>
  new WebhookProcessor({
    marketId: "EG", now: () => new Date(w.clock.t), config: defaultConfig(), reservations: w.reservations, provider: w.fakes.provider, shipping: w.fakes.shipping, address: w.fakes.address,
    risk: w.fakes.risk, commission: w.fakes.commission, taxCategories: new FakeTaxCategories(), taxRates: InMemoryTaxRateProvider.withMarketDefaults(["eg"]), credit: new PgStoreCredit("EGP"),
    tokens: new HmacQuoteTokens(), prices: w.fakes.prices, killSwitches: w.fakes.kill, subMerchants: w.fakes.subs, billing: new FakeBilling(), refunds: w.fakes.refunds,
    ...over, client: w.workerClient, cipher: over.cipher ?? new FakeCipher(),
  });

describe("WebhookProcessor: rejection and ignore paths", () => {
  it("a validly signed but malformed body is stored as rejected and reports the verifier's reason", async () => {
    const res = await w.webhooks.handle(signedRaw("not json at all"));
    expect(res).toEqual({ outcome: "rejected", reason: "malformed" });
    const row = await w.raw.query<{ processing_status: string; signature_ok: boolean; provider_event_id: string }>("SELECT processing_status, signature_ok, provider_event_id FROM payment_events_raw WHERE failure_reason = 'malformed'");
    expect(row.rows[0]).toMatchObject({ processing_status: "rejected", signature_ok: false });
    expect(row.rows[0]?.provider_event_id.startsWith("unverified:")).toBe(true);
  });

  it("a replayed bad-signature body adds no second raw row", async () => {
    const bad = w.fakes.provider.webhook({ id: "replay-bad", type: "payment.succeeded", merchantReference: null, providerRef: "r", amountMinor: 1n }, { badSignature: true });
    await w.webhooks.handle(bad);
    const before = (await w.raw.query("SELECT 1 FROM payment_events_raw WHERE processing_status = 'rejected'")).rows.length;
    expect(await w.webhooks.handle(bad)).toEqual({ outcome: "rejected", reason: "bad_signature" });
    expect((await w.raw.query("SELECT 1 FROM payment_events_raw WHERE processing_status = 'rejected'")).rows.length).toBe(before);
  });

  it("null and non-UUID merchant references are both intent_not_found, never a SQL error", async () => {
    for (const [i, ref] of [null, "not-a-uuid", "1; DROP TABLE payment_intents"].entries()) {
      const res = await w.webhooks.handle(w.fakes.provider.webhook({ id: `ref-${String(i)}`, type: "payment.succeeded", merchantReference: ref, providerRef: "r", amountMinor: 1n }));
      expect(res).toEqual({ outcome: "rejected", reason: "intent_not_found" });
      expect(await rawStatus(`ref-${String(i)}`)).toEqual({ processing_status: "rejected", failure_reason: "intent_not_found" });
    }
  });

  it("an intent owned by another provider is rejected and the order is untouched", async () => {
    const { r, intent } = await place(0, 20_000n, 2);
    await w.raw.query("UPDATE payment_intents SET provider = 'kashier' WHERE id = $1", [intent.id]);
    expect(await w.webhooks.handle(paidWebhook(w, intent, "prov-mm"))).toEqual({ outcome: "rejected", reason: "provider_mismatch" });
    expect(await groupStatus(r.orderGroupId)).toBe("PENDING_PAYMENT");
    expect(await w.outboxTypes()).toContain("payment.webhook_rejected");
  });

  it("a payment.failed in another currency is rejected as currency_mismatch and does not compensate", async () => {
    const { r, intent } = await place(0, 20_000n, 2);
    const res = await w.webhooks.handle(signedRaw({ id: "cur-mm", type: "payment.failed", merchantReference: intent.id, providerRef: "r", amountMinor: intent.amount_minor, currency: "USD", failureCode: null }));
    expect(res).toEqual({ outcome: "rejected", reason: "currency_mismatch" });
    expect(await groupStatus(r.orderGroupId)).toBe("PENDING_PAYMENT");
  });

  it("a succeeded event in another currency is an amount_mismatch even when the number matches", async () => {
    const { r, intent } = await place(0, 20_000n, 2);
    const res = await w.webhooks.handle(signedRaw({ id: "cur-mm2", type: "payment.succeeded", merchantReference: intent.id, providerRef: "r", amountMinor: intent.amount_minor, currency: "USD", failureCode: null }));
    expect(res).toEqual({ outcome: "rejected", reason: "amount_mismatch" });
    expect(await groupStatus(r.orderGroupId)).toBe("PENDING_PAYMENT");
  });

  it("non-terminal event types are recorded as ignored and change nothing", async () => {
    const { r, intent } = await place(0, 20_000n, 2);
    const res = await w.webhooks.handle(w.fakes.provider.webhook({ id: "pend-1", type: "payment.pending", merchantReference: intent.id, providerRef: "r", amountMinor: BigInt(intent.amount_minor) }));
    expect(res).toEqual({ outcome: "ignored", detail: "payment.pending" });
    expect(await rawStatus("pend-1")).toEqual({ processing_status: "ignored", failure_reason: "payment.pending" });
    expect(await groupStatus(r.orderGroupId)).toBe("PENDING_PAYMENT");
  });

  it("the provider reference is back-filled from the event when the intent has none", async () => {
    const { intent } = await place(0, 20_000n, 2);
    await w.raw.query("UPDATE payment_intents SET provider_ref = NULL WHERE id = $1", [intent.id]);
    await w.webhooks.handle(w.fakes.provider.webhook({ id: "fill-1", type: "payment.succeeded", merchantReference: intent.id, providerRef: "psp-ref-9", amountMinor: BigInt(intent.amount_minor) }));
    expect((await intentOf(w, (await w.raw.query<{ order_group_id: string }>("SELECT order_group_id FROM payment_intents WHERE id = $1", [intent.id])).rows[0]?.order_group_id ?? "")).provider_ref).toBe("psp-ref-9");
  });

  it("a failure after settlement is ignored and the paid order stays PAID", async () => {
    const { r, intent } = await place(0, 20_000n, 2);
    await w.webhooks.handle(paidWebhook(w, intent, "settle-ok"));
    const res = await w.webhooks.handle(paidWebhook(w, intent, "settle-fail", "payment.failed"));
    expect(res).toEqual({ outcome: "ignored", detail: "failure_after_settlement" });
    expect(await rawStatus("settle-fail")).toEqual({ processing_status: "ignored", failure_reason: "failed_after_paid" });
    expect(await groupStatus(r.orderGroupId)).toBe("PAID");
  });

  it("a success for a group with no reservation fails loudly, marks the raw row failed and keeps the order pending", async () => {
    const { r, intent } = await place(0, 20_000n, 2);
    await w.raw.query("ALTER TABLE order_groups DISABLE TRIGGER USER");
    try {
      await w.raw.query("UPDATE order_groups SET reservation_id = NULL WHERE id = $1", [r.orderGroupId]);
    } finally {
      await w.raw.query("ALTER TABLE order_groups ENABLE TRIGGER USER");
    }
    await expect(w.webhooks.handle(paidWebhook(w, intent, "no-res"))).rejects.toMatchObject({ code: "invalid-state" });
    expect((await rawStatus("no-res")).processing_status).toBe("failed");
    expect(await groupStatus(r.orderGroupId)).toBe("PENDING_PAYMENT");
  });

  it("a cipher failure aborts before anything is stored or changed", async () => {
    const { r, intent } = await place(0, 20_000n, 2);
    const broken = workerWith({ cipher: { encrypt: () => Promise.reject(new Error("kms down")) } });
    await expect(broken.handle(paidWebhook(w, intent, "kms-down"))).rejects.toThrow("kms down");
    expect((await rawStatus("kms-down")).processing_status).toBe("missing");
    expect(await groupStatus(r.orderGroupId)).toBe("PENDING_PAYMENT");
  });
});

describe("WebhookProcessor: late and unavailable-stock paths", () => {
  it("success while the reservation lapsed and stock is gone (group still pending): compensate then owe a refund", async () => {
    const { r, intent, sku } = await place(1, 30_000n, 1);
    w.clock.t += 11 * 60_000;
    await w.reservations.sweepExpired(new Date(w.clock.t));
    const other = await w.newUser();
    await w.fillBag(other, [{ sku, qty: 1 }]);
    expect((await (await quoteAndPlace(w, other, "cod")).place()).status).toBe("CONFIRMED_COD");
    const n = w.fakes.refunds.requests.length;
    expect(await w.webhooks.handle(paidWebhook(w, intent, "gone-1"))).toEqual({ outcome: "processed", detail: "late_refund" });
    expect(await groupStatus(r.orderGroupId)).toBe("REFUND_PENDING");
    expect(w.fakes.refunds.requests.length).toBe(n); // the webhook no longer calls the RefundPort inline (C4)
    expect(await new LateRefundConsumer(w.raw, w.fakes.refunds).handle(await lateRefundEvent(r.orderGroupId))).toBe("processed");
    expect(w.fakes.refunds.requests.length).toBe(n + 1);
  });

  it("a refund port that fails does not fail the webhook; the ledger already owes the refund and the consumer retries", async () => {
    const { r, intent, sku } = await place(1, 30_000n, 1);
    w.clock.t += 11 * 60_000;
    await w.reservations.sweepExpired(new Date(w.clock.t));
    const other = await w.newUser();
    await w.fillBag(other, [{ sku, qty: 1 }]);
    await (await quoteAndPlace(w, other, "cod")).place();
    const hostile = workerWith({ refunds: { requestRefund: () => Promise.reject(new Error("refund api 500")) } });
    expect(await hostile.handle(paidWebhook(w, intent, "refund-500"))).toEqual({ outcome: "processed", detail: "late_refund" });
    await expect(new LateRefundConsumer(w.raw, { requestRefund: () => Promise.reject(new Error("refund api 500")) }).handle(await lateRefundEvent(r.orderGroupId))).rejects.toThrow("refund api 500");
    expect(await groupStatus(r.orderGroupId)).toBe("REFUND_PENDING");
    expect((await w.raw.query("SELECT 1 FROM journal_entries WHERE idempotency_key = $1", [`late_refund:${r.orderGroupId}`])).rows.length).toBe(1);
  });

  it("late success after PAYMENT_FAILED: the released reservation is terminal, so the money is refunded", async () => {
    // a synchronous, non-retryable PSP decline is final (a webhook decline on an external method is not: see checkout.test.ts, C1)
    const sku = await w.seedSku(w.stores[0], 100_000n, 3);
    const u = await w.newUser();
    await w.grantCredit(u, 30_000n);
    await w.fillBag(u, [{ sku, qty: 1 }]);
    w.fakes.provider.nextCreate = "decline";
    try { await (await quoteAndPlace(w, u, "card", { creditRequested: money(30_000n, "EGP") })).place().catch(() => undefined); } finally { w.fakes.provider.nextCreate = "requires_action"; }
    const gid = (await w.raw.query<{ id: string }>("SELECT id FROM order_groups WHERE user_id = $1", [u])).rows[0]?.id ?? "";
    const r = { orderGroupId: gid };
    const intent = await intentOf(w, gid);
    expect(await groupStatus(r.orderGroupId)).toBe("PAYMENT_FAILED");
    // the reservation was explicitly RELEASED by the compensation: terminal, so the late money must be refunded
    expect(await w.webhooks.handle(paidWebhook(w, intent, "pf-late"))).toEqual({ outcome: "processed", detail: "late_refund" });
    expect(await groupStatus(r.orderGroupId)).toBe("REFUND_PENDING");
  });

  it("late success on an expired group whose credit was spent elsewhere is refunded (credit-insufficient)", async () => {
    const { r, intent, u } = await place(0, 100_000n, 3, 30_000n);
    await lapse(r.orderGroupId);
    expect(await groupStatus(r.orderGroupId)).toBe("EXPIRED");
    // the user's whole credit leaves the account before the money arrives
    await w.raw.transaction((tx) => Ledger.post(tx, {
      kind: "store_credit_expired", idempotencyKey: `drain:${u}`, marketId: "EG", occurredAt: new Date(w.clock.t), ref: { type: "user", id: u },
      postings: [
        { accountCode: accountCode({ type: "store_credit", market: "EG", currency: "EGP", owner: u, sub: "goodwill" }), amount: money(30_000n, "EGP") },
        { accountCode: accountCode({ type: "goodwill_expense", market: "EG", currency: "EGP" }), amount: money(-30_000n, "EGP") },
      ],
    }));
    expect(await w.webhooks.handle(paidWebhook(w, intent, "drained"))).toEqual({ outcome: "processed", detail: "late_refund" });
    expect(await groupStatus(r.orderGroupId)).toBe("REFUND_PENDING");
    expect(await w.raw.query("SELECT 1 FROM ledger_holds WHERE ref_id = $1 AND status = 'HELD'", [r.orderGroupId]).then((x) => x.rows.length)).toBe(0);
  });

  it("an unexpected error while re-holding credit is not swallowed as a refund: it surfaces and the raw row is failed", async () => {
    const { r, intent } = await place(0, 100_000n, 3, 30_000n);
    await lapse(r.orderGroupId);
    const brokenCredit = new PgStoreCredit("EGP");
    brokenCredit.hold = () => Promise.reject(new Error("ledger offline"));
    const broken = workerWith({ credit: brokenCredit });
    await expect(broken.handle(paidWebhook(w, intent, "hold-boom"))).rejects.toThrow();
    expect((await rawStatus("hold-boom")).processing_status).toBe("failed");
    expect(await groupStatus(r.orderGroupId)).toBe("EXPIRED");
  });
});

describe("PgStoreCredit", () => {
  const credit = new PgStoreCredit("EGP");
  const grant = (u: string, sub: "goodwill" | "refund_credit" | "gift_card", amt: bigint) => w.raw.transaction((tx) => Ledger.post(tx, {
    kind: "store_credit_granted", idempotencyKey: `g:${u}:${sub}`, marketId: "EG", occurredAt: new Date(w.clock.t), ref: { type: "user", id: u },
    postings: [
      { accountCode: accountCode({ type: "goodwill_expense", market: "EG", currency: "EGP" }), amount: money(amt, "EGP") },
      { accountCode: accountCode({ type: "store_credit", market: "EG", currency: "EGP", owner: u, sub }), amount: money(-amt, "EGP") },
    ],
  }));
  const hold = (u: string, g: string, amt: bigint) => w.raw.transaction((tx) => credit.hold(tx, { userId: u, marketId: "EG", orderGroupId: g, amount: money(amt, "EGP"), expiresAt: new Date(w.clock.t + 60_000) }));
  const groupFor = async (u: string): Promise<string> => {
    const sku = await w.seedSku(w.stores[2], 1_000n, 1);
    await w.fillBag(u, [{ sku, qty: 1 }]);
    return (await (await quoteAndPlace(w, u, "cod")).place()).orderGroupId;
  };

  it("a user with no credit has zero available and cannot hold anything", async () => {
    const u = await w.newUser();
    expect((await w.raw.transaction((tx) => credit.available(tx, u, "EG"))).amountMinor).toBe(0n);
    await expect(hold(u, randomUUID(), 1n)).rejects.toMatchObject({ code: "credit-insufficient" });
  });

  it("holding more than the balance throws credit-insufficient and leaves no partial hold rows", async () => {
    const u = await w.newUser();
    await grant(u, "goodwill", 5_000n);
    const g = await groupFor(u);
    await expect(hold(u, g, 5_001n)).rejects.toBeInstanceOf(CheckoutError);
    expect((await w.raw.query("SELECT 1 FROM ledger_holds WHERE user_id = $1", [u])).rows.length).toBe(0);
    expect((await w.raw.transaction((tx) => credit.available(tx, u, "EG"))).amountMinor).toBe(5_000n);
  });

  it("a zero-amount hold succeeds with no rows; spend order drains goodwill before refund credit", async () => {
    const u = await w.newUser();
    await grant(u, "refund_credit", 4_000n);
    await grant(u, "goodwill", 1_500n);
    const g = await groupFor(u);
    expect(await hold(u, g, 0n)).toEqual([]);
    const parts = await hold(u, g, 2_000n);
    expect(parts.map((p) => [p.accountCode.split(":").at(-1), p.amount.amountMinor])).toEqual([["goodwill", 1_500n], ["refund_credit", 500n]]);
    expect((await w.raw.transaction((tx) => credit.available(tx, u, "EG"))).amountMinor).toBe(3_500n - 0n + 0n);
  });

  it("held funds are not spendable twice, heldFor lists them, and a repeated hold on the same group gets a fresh idempotency suffix", async () => {
    const u = await w.newUser();
    await grant(u, "goodwill", 3_000n);
    const g = await groupFor(u);
    await hold(u, g, 1_000n);
    await hold(u, g, 1_000n);
    const held = await w.raw.transaction((tx) => credit.heldFor(tx, g));
    expect(held.reduce((a, h) => a + h.amount.amountMinor, 0n)).toBe(2_000n);
    await expect(hold(u, randomUUID(), 1_001n)).rejects.toMatchObject({ code: "credit-insufficient" });
    expect((await w.raw.transaction((tx) => credit.available(tx, u, "EG"))).amountMinor).toBe(1_000n);
  });

  it("release works once; releasing twice, or capturing after release, touches zero rows", async () => {
    const u = await w.newUser();
    await grant(u, "goodwill", 2_000n);
    const g = await groupFor(u);
    await hold(u, g, 2_000n);
    expect(await w.raw.transaction((tx) => credit.release(tx, g, "RELEASED"))).toBe(1);
    expect(await w.raw.transaction((tx) => credit.release(tx, g, "RELEASED"))).toBe(0);
    expect(await w.raw.transaction((tx) => credit.release(tx, g, "EXPIRED"))).toBe(0);
    expect(await w.raw.transaction((tx) => credit.markCaptured(tx, g, randomUUID()))).toBe(0);
    expect(await w.raw.transaction((tx) => credit.heldFor(tx, g))).toEqual([]);
    expect((await w.raw.transaction((tx) => credit.available(tx, u, "EG"))).amountMinor).toBe(2_000n);
  });

  it("an EXPIRED release records that status, and a hold larger than a shrunken balance counts as zero spendable (never negative)", async () => {
    const u = await w.newUser();
    await grant(u, "gift_card", 2_000n);
    const g = await groupFor(u);
    await hold(u, g, 2_000n);
    await w.raw.transaction((tx) => Ledger.post(tx, {
      kind: "store_credit_expired", idempotencyKey: `shrink:${u}`, marketId: "EG", occurredAt: new Date(w.clock.t), ref: { type: "user", id: u },
      postings: [
        { accountCode: accountCode({ type: "store_credit", market: "EG", currency: "EGP", owner: u, sub: "gift_card" }), amount: money(1_500n, "EGP") },
        { accountCode: accountCode({ type: "goodwill_expense", market: "EG", currency: "EGP" }), amount: money(-1_500n, "EGP") },
      ],
    }));
    expect((await w.raw.transaction((tx) => credit.available(tx, u, "EG"))).amountMinor).toBe(0n);
    await expect(hold(u, randomUUID(), 1n)).rejects.toMatchObject({ code: "credit-insufficient" });
    expect(await w.raw.transaction((tx) => credit.release(tx, g, "EXPIRED"))).toBe(1);
    expect((await w.raw.query<{ status: string }>("SELECT status FROM ledger_holds WHERE ref_id = $1", [g])).rows[0]?.status).toBe("EXPIRED");
  });
});

describe("eachStoreContext", () => {
  it("returns an empty map for no stores without touching the session", async () => {
    const out = await w.raw.transaction((tx) => eachStoreContext(tx, "EG", [], () => Promise.resolve(1)));
    expect(out.size).toBe(0);
  });

  it("binds each store in turn with no user, then restores the previous (empty) context", async () => {
    const [a, b] = w.stores;
    const seen = await w.raw.transaction(async (tx) => {
      const out = await eachStoreContext(tx, "EG", [a, b], async (s) => ({ s, bound: (await tx.query<{ v: string }>("SELECT current_setting('app.current_store_id', true) AS v")).rows[0]?.v, user: (await tx.query<{ v: string | null }>("SELECT current_setting('app.current_user_id', true) AS v")).rows[0]?.v }));
      const after = (await tx.query<{ v: string | null }>("SELECT current_setting('app.current_store_id', true) AS v")).rows[0]?.v;
      return { out, after };
    });
    expect(seen.out.get(a)).toMatchObject({ s: a, bound: a });
    expect(seen.out.get(b)).toMatchObject({ s: b, bound: b });
    expect(seen.out.get(a)?.user ?? "").toBe("");
    expect(seen.after ?? "").toBe("");
  });

  it("treats never-set settings (null on a fresh session) as empty and restores them as empty", async () => {
    const { client, close } = await createTestClient();
    try {
      const seen = await client.transaction(async (tx) => {
        const out = await eachStoreContext(tx, "EG", [w.stores[0]], async () => (await tx.query<{ v: string | null }>("SELECT current_setting('app.current_store_id', true) AS v")).rows[0]?.v);
        const after = (await tx.query<{ v: string | null }>("SELECT current_setting('app.current_store_id', true) AS v")).rows[0]?.v;
        return { inner: out.get(w.stores[0]), after: after ?? "" };
      });
      expect(seen).toEqual({ inner: w.stores[0], after: "" });
    } finally {
      await close();
    }
  });

  it("keeps the caller's user id inside each store context and restores it afterwards", async () => {
    const u = await w.newUser();
    const [a] = w.stores;
    const seen = await w.raw.transaction(async (tx) => {
      await tx.query("SELECT set_config('app.current_user_id', $1, true)", [u]);
      const inner = await eachStoreContext(tx, "EG", [a], async () => (await tx.query<{ v: string }>("SELECT current_setting('app.current_user_id', true) AS v")).rows[0]?.v);
      const after = (await tx.query<{ v: string }>("SELECT current_setting('app.current_user_id', true) AS v")).rows[0]?.v;
      return { inner: inner.get(a), after };
    });
    expect(seen).toEqual({ inner: u, after: u });
  });
});

describe("makeEnv and errors", () => {
  const deps = (): CommonDeps => ({
    marketId: "EG", config: defaultConfig(), reservations: w.reservations, provider: w.fakes.provider, shipping: w.fakes.shipping, address: w.fakes.address, risk: w.fakes.risk,
    commission: w.fakes.commission, taxCategories: new FakeTaxCategories(), taxRates: InMemoryTaxRateProvider.withMarketDefaults(["eg"]), credit: new PgStoreCredit("EGP"),
    tokens: new HmacQuoteTokens(), prices: w.fakes.prices, killSwitches: w.fakes.kill, subMerchants: w.fakes.subs, billing: new FakeBilling(), refunds: w.fakes.refunds,
  });

  it("fills defaults when optional deps are absent and honours explicit ones", () => {
    const env = makeEnv(deps());
    expect(env.currency).toBe("EGP");
    expect(env.outbox).toBeInstanceOf(OutboxWriter);
    expect(Math.abs(env.now().getTime() - Date.now())).toBeLessThan(5_000);
    expect(env.newId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(env.newId()).not.toBe(env.newId());
    const fixed = new Date(0);
    const outbox = new OutboxWriter(pgTransactionalWriter);
    const custom = makeEnv({ ...deps(), currency: "USD", now: () => fixed, newId: () => "id-1", outbox });
    expect([custom.currency, custom.now(), custom.newId(), custom.outbox]).toEqual(["USD", fixed, "id-1", outbox]);
  });

  it("maps every error code to its HTTP status and defaults details to empty", () => {
    const table: Record<CheckoutErrorCode, number> = {
      "quote-token-invalid": 422, "quote-expired": 409, "price-changed": 409, "stock-shortfall": 409, "method-unavailable": 403, "address-not-found": 404, "empty-bag": 422,
      "idempotency-conflict": 422, "credit-insufficient": 422, "cod-credit-unsupported": 422, "cod-not-allowed": 403, "store-not-onboarded": 409, "payment-declined": 402,
      "psp-unavailable": 503, "not-found": 404, "invalid-state": 409, "webhook-rejected": 400, "invalid-quantity": 422,
      "cancel-after-shipping": 409, "order-not-cancellable": 409, "refund-preference-invalid": 422, "payment-in-flight": 409,
    };
    for (const [code, status] of Object.entries(table) as [CheckoutErrorCode, number][]) {
      const e = new CheckoutError(code, "m");
      expect([e.status, e.code, e.name, e.details]).toEqual([status, code, "CheckoutError", {}]);
    }
    const withDetails = new CheckoutError("stock-shortfall", "m", { riskDecision: "block" });
    expect(withDetails.details).toEqual({ riskDecision: "block" });
    const net = new SellerNetError("store-1", -5n);
    expect([net.code, net.storeId, net.netMinor, net.name]).toEqual(["seller-net-negative", "store-1", -5n, "SellerNetError"]);
  });
});
