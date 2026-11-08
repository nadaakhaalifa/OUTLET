import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Ledger } from "@outlet/ledger";
import { money } from "@outlet/money";
import { LateRefundConsumer, PAYMENT_METHODS, UnconfiguredRisk } from "../src/index.js";
import { RecordingRefunds } from "../src/testing.js";
import { withDbContext } from "@outlet/db";
import { eachStoreContext } from "../src/application/context.js";
import { HmacQuoteTokens } from "../src/testing.js";
import { uuidv7 } from "@outlet/ids";
import { createHmac } from "node:crypto";
import type { PaymentMethod } from "../src/index.js";
import { KILL_SWITCH_OF } from "../src/domain/methods.js";
import { ADDR, buildWorld, errCode, intentOf, paidWebhook, quoteAndPlace } from "./fixtures.js";
import type { World } from "./fixtures.js";

let w: World;
beforeAll(async () => { w = await buildWorld(); });
afterAll(async () => { await w.close(); });

const sumBy = async (groupId: string): Promise<Map<string, bigint>> => {
  const r = await w.raw.query<{ code: string; amt: string }>(
    `SELECT a.code, SUM(p.amount_minor)::text AS amt FROM postings p JOIN ledger_accounts a ON a.id = p.account_id JOIN journal_entries e ON e.id = p.entry_id
      WHERE e.idempotency_key = $1 GROUP BY a.code`,
    [`order_paid:${groupId}`],
  );
  return new Map(r.rows.map((x) => [x.code, BigInt(x.amt)]));
};
const lateRefundEvent = async (groupId: string): Promise<{ id: string; payload: Record<string, unknown> }> => {
  const row = (await w.raw.query<{ id: string; payload: Record<string, unknown> }>("SELECT id, payload FROM outbox_events WHERE event_type = 'order_group.late_payment_refund' AND payload ->> 'order_group_id' = $1", [groupId])).rows[0];
  if (row === undefined) throw new Error("no late refund event");
  return row;
};
const trial = async (): Promise<bigint> => (await Ledger.trialBalance(w.raw, "EG", "EGP")).amountMinor;
const status = async (id: string): Promise<string> => (await w.raw.query<{ status: string }>("SELECT status FROM order_groups WHERE id = $1", [id])).rows[0]?.status ?? "";
const groupCount = async (userId: string): Promise<number> => (await w.raw.query("SELECT 1 FROM order_groups WHERE user_id = $1", [userId])).rows.length;

describe("acceptance: three stores, one payment (ledger spec 4.1 model A)", () => {
  it("one charge equals the sum; 3 seller payables + commission + VAT + shipping; trial balance 0", async () => {
    const [A, B, C] = w.stores;
    w.fakes.shipping.fees.set(A, 0n); w.fakes.shipping.fees.set(B, 6000n); w.fakes.shipping.fees.set(C, 6000n);
    const sA = await w.seedSku(A, 249_900n); const sB = await w.seedSku(B, 89_950n); const sC = await w.seedSku(C, 45_000n);
    const u = await w.newUser();
    await w.fillBag(u, [{ sku: sA, qty: 1 }, { sku: sB, qty: 1 }, { sku: sC, qty: 1 }]);
    const t0 = await trial();
    const { q, place } = await quoteAndPlace(w, u, "card");
    expect(q.quote.total.amountMinor).toBe(396_850n);
    const r = await place();
    expect(r.status).toBe("PENDING_PAYMENT");
    expect(r.clientAction.kind).toBe("redirect");
    const call = w.fakes.provider.createCalls.at(-1);
    expect(call?.key).toBe(r.orderGroupId);
    expect(call?.req.amount.amountMinor).toBe(396_850n);
    const split = call?.req.split ?? [];
    expect(split.reduce((a, s) => a + s.sellerAmount.amountMinor + s.platformAmount.amountMinor, 0n)).toBe(396_850n);
    expect(split.map((s) => s.sellerAmount.amountMinor).sort()).toEqual([207_167n, 37_305n, 74_569n].sort());
    const intent = await intentOf(w, r.orderGroupId);
    expect(intent.status).toBe("REQUIRES_ACTION");
    expect(await w.free(sA)).toBe(5);

    expect(await w.webhooks.handle(paidWebhook(w, intent, `evt-${r.orderGroupId}`))).toMatchObject({ outcome: "processed", detail: "paid" });
    expect(await status(r.orderGroupId)).toBe("PAID");
    const s = await sumBy(r.orderGroupId);
    const code = (type: string, owner?: string): string => `${type}:EG:EGP${owner === undefined ? "" : `:${owner}`}`;
    expect(s.get(code("psp_clearing", "paymob"))).toBe(396_850n);
    expect(s.get(code("seller_pending", A))).toBe(-207_167n);
    expect(s.get(code("seller_pending", B))).toBe(-74_569n);
    expect(s.get(code("seller_pending", C))).toBe(-37_305n);
    expect(s.get(code("commission_revenue"))).toBe(-57_727n);
    expect(s.get(code("platform_vat_output"))).toBe(-9_556n);
    expect(s.get(code("shipping_revenue"))).toBe(-10_526n);
    expect(s.size).toBe(7);
    expect(await trial()).toBe(t0);
    expect(t0).toBe(0n);
    const view = await w.svc.getOrderGroup(u, r.orderGroupId);
    expect(view.sellerOrders.map((x) => x.status)).toEqual(["PAID", "PAID", "PAID"]);
    expect(view.sellerOrders.reduce((a, x) => a + x.total.amountMinor, 0n)).toBe(396_850n);
    expect(await w.free(sA)).toBe(4); // committed
    const ev = await w.outboxTypes();
    expect(ev).toContain("order_group.placed");
    expect(ev).toContain("order_group.paid");
    expect(ev).toContain("inventory.claimed");
  });
});

describe("idempotency and webhooks", () => {
  it("duplicate taps give one order group, one reservation and one PSP call", async () => {
    const sku = await w.seedSku(w.stores[0], 20_000n);
    const u = await w.newUser();
    await w.fillBag(u, [{ sku, qty: 1 }]);
    const calls = w.fakes.provider.createCalls.length;
    const { place } = await quoteAndPlace(w, u, "card");
    const [a, b] = await Promise.all([place(), place()]);
    expect(a.orderGroupId).toBe(b.orderGroupId);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(await groupCount(u)).toBe(1);
    // a racing replay may call the PSP again, always with the same key (the PSP returns the same intent)
    const keys = new Set(w.fakes.provider.createCalls.slice(calls).map((c) => c.key));
    expect([...keys]).toEqual([a.orderGroupId]);
    expect((await w.raw.query("SELECT 1 FROM reservations WHERE order_group_ref = $1", [a.orderGroupId])).rows).toHaveLength(1);
  });

  it("the same key with a different quote is 422 idempotency-conflict", async () => {
    const sku = await w.seedSku(w.stores[0], 20_000n);
    const u = await w.newUser();
    await w.fillBag(u, [{ sku, qty: 1 }]);
    const first = await quoteAndPlace(w, u, "card");
    await first.place();
    const second = await quoteAndPlace(w, u, "card", { idempotencyKey: first.key });
    expect(await errCode(second.place())).toBe("idempotency-conflict");
  });

  it("a duplicate webhook does not claim or post twice", async () => {
    const sku = await w.seedSku(w.stores[1], 30_000n, 3);
    const u = await w.newUser();
    await w.fillBag(u, [{ sku, qty: 2 }]);
    const r = await (await quoteAndPlace(w, u, "card")).place();
    const intent = await intentOf(w, r.orderGroupId);
    const hook = paidWebhook(w, intent, `dup-${r.orderGroupId}`);
    expect(await w.webhooks.handle(hook)).toMatchObject({ outcome: "processed" });
    expect(await w.webhooks.handle(hook)).toEqual({ outcome: "duplicate" });
    // a different event id for the same payment is idempotent too (state machine and ledger key)
    expect(await w.webhooks.handle(paidWebhook(w, intent, `dup2-${r.orderGroupId}`))).toMatchObject({ outcome: "ignored" });
    expect((await w.raw.query("SELECT 1 FROM journal_entries WHERE idempotency_key = $1", [`order_paid:${r.orderGroupId}`])).rows).toHaveLength(1);
    expect(await w.free(sku)).toBe(1); // 3 on hand, 2 committed once
    expect((await w.raw.query("SELECT 1 FROM outbox_events WHERE event_type = 'order_group.paid' AND aggregate_id = $1", [r.orderGroupId])).rows).toHaveLength(1);
  });

  it("webhook before the redirect returns: the order is already PAID when place() answers", async () => {
    const sku = await w.seedSku(w.stores[0], 15_000n);
    const u = await w.newUser();
    await w.fillBag(u, [{ sku, qty: 1 }]);
    w.fakes.provider.onCreated = async ({ providerRef, req }) => {
      await w.webhooks.handle(w.fakes.provider.webhook({ id: `early-${req.orderGroupId}`, type: "payment.succeeded", merchantReference: req.paymentIntentId, providerRef, amountMinor: req.amount.amountMinor }));
    };
    try {
      const r = await (await quoteAndPlace(w, u, "card")).place();
      expect(r.status).toBe("PAID");
      expect((await intentOf(w, r.orderGroupId)).status).toBe("CAPTURED");
      expect((await w.svc.getOrderGroup(u, r.orderGroupId)).status).toBe("PAID");
    } finally {
      w.fakes.provider.onCreated = null;
    }
  });

  it("bad signature: stored under an unverified id, rejected, no state change; raw body is stored encrypted with its sha256", async () => {
    const sku = await w.seedSku(w.stores[0], 15_000n);
    const u = await w.newUser();
    await w.fillBag(u, [{ sku, qty: 1 }]);
    const r = await (await quoteAndPlace(w, u, "card")).place();
    const intent = await intentOf(w, r.orderGroupId);
    const bad = w.fakes.provider.webhook({ id: "x", type: "payment.succeeded", merchantReference: intent.id, providerRef: "r", amountMinor: BigInt(intent.amount_minor) }, { badSignature: true });
    expect(await w.webhooks.handle(bad)).toEqual({ outcome: "rejected", reason: "bad_signature" });
    expect(await status(r.orderGroupId)).toBe("PENDING_PAYMENT");
    const row = (await w.raw.query<{ provider_event_id: string; signature_ok: boolean; body_ct: Uint8Array; body_sha256: Uint8Array }>("SELECT provider_event_id, signature_ok, body_ct, body_sha256 FROM payment_events_raw WHERE provider_event_id LIKE 'unverified:%' ORDER BY received_at DESC LIMIT 1")).rows[0];
    expect(row?.signature_ok).toBe(false);
    expect(Buffer.from(row?.body_ct ?? []).includes(Buffer.from('"payment.succeeded"'))).toBe(false);
    expect(Buffer.from(row?.body_sha256 ?? []).toString("hex")).toBe((await import("../src/application/hash.js")).sha256Hex(bad.rawBody));
  });

  it("amount mismatch and unknown intent are rejected without touching the order", async () => {
    const sku = await w.seedSku(w.stores[0], 15_000n);
    const u = await w.newUser();
    await w.fillBag(u, [{ sku, qty: 1 }]);
    const r = await (await quoteAndPlace(w, u, "card")).place();
    const intent = await intentOf(w, r.orderGroupId);
    const wrong = w.fakes.provider.webhook({ id: `wrong-${r.orderGroupId}`, type: "payment.succeeded", merchantReference: intent.id, providerRef: "r", amountMinor: 1n });
    expect(await w.webhooks.handle(wrong)).toEqual({ outcome: "rejected", reason: "amount_mismatch" });
    expect(await status(r.orderGroupId)).toBe("PENDING_PAYMENT");
    const unknown = w.fakes.provider.webhook({ id: `unk-${r.orderGroupId}`, type: "payment.succeeded", merchantReference: "01900000-0000-7000-8000-00000000dead", providerRef: "r", amountMinor: 1n });
    expect(await w.webhooks.handle(unknown)).toEqual({ outcome: "rejected", reason: "intent_not_found" });
    expect(await w.outboxTypes()).toContain("payment.webhook_rejected");
  });
});

describe("expiry and late payment", () => {
  const expireNow = async (groupId: string): Promise<void> => { await w.raw.query("UPDATE order_groups SET payment_expires_at = now() - interval '1 minute' WHERE id = $1", [groupId]); };

  it("expired then paid: the lapsed reservation is auto-claimed (late claim) and the order becomes PAID", async () => {
    const sku = await w.seedSku(w.stores[0], 25_000n, 2);
    const u = await w.newUser();
    await w.fillBag(u, [{ sku, qty: 1 }]);
    const r = await (await quoteAndPlace(w, u, "card")).place();
    const intent = await intentOf(w, r.orderGroupId);
    await expireNow(r.orderGroupId);
    const res = await w.sweeper.run();
    expect(res.expired).toContain(r.orderGroupId);
    expect(w.fakes.provider.voidCalls.at(-1)?.paymentIntentId).toBe(intent.id);
    expect(await status(r.orderGroupId)).toBe("EXPIRED");
    expect((await w.svc.getOrderGroup(u, r.orderGroupId)).sellerOrders[0]?.status).toBe("VOIDED");
    w.clock.t += 11 * 60_000;
    expect((await w.reservations.sweepExpired(new Date(w.clock.t))).expired.length).toBeGreaterThan(0);
    expect(await w.webhooks.handle(paidWebhook(w, intent, `late-${r.orderGroupId}`))).toMatchObject({ outcome: "processed", detail: "late_paid" });
    expect(await status(r.orderGroupId)).toBe("PAID");
    expect((await intentOf(w, r.orderGroupId)).status).toBe("CAPTURED");
    expect((await w.svc.getOrderGroup(u, r.orderGroupId)).sellerOrders[0]?.status).toBe("PAID");
    expect(await w.free(sku)).toBe(1);
    expect(await trial()).toBe(0n);
  });

  it("expired then paid with no stock left: REFUND_PENDING, a refund request and the apology event", async () => {
    const sku = await w.seedSku(w.stores[1], 25_000n, 1);
    const u = await w.newUser();
    await w.fillBag(u, [{ sku, qty: 1 }]);
    const r = await (await quoteAndPlace(w, u, "card")).place();
    const intent = await intentOf(w, r.orderGroupId);
    await expireNow(r.orderGroupId);
    await w.sweeper.run();
    w.clock.t += 11 * 60_000;
    await w.reservations.sweepExpired(new Date(w.clock.t));
    // someone else buys the last unit (cash on delivery claims at once)
    const other = await w.newUser();
    await w.fillBag(other, [{ sku, qty: 1 }]);
    expect((await (await quoteAndPlace(w, other, "cod")).place()).status).toBe("CONFIRMED_COD");
    const refunds = w.fakes.refunds.requests.length;
    expect(await w.webhooks.handle(paidWebhook(w, intent, `late2-${r.orderGroupId}`))).toMatchObject({ outcome: "processed", detail: "late_refund" });
    expect(await status(r.orderGroupId)).toBe("REFUND_PENDING");
    expect(w.fakes.refunds.requests.length).toBe(refunds); // C4: no inline RefundPort call; the outbox event owns the request
    const ev = await lateRefundEvent(r.orderGroupId);
    expect(ev.payload).toMatchObject({ idempotency_key: `late_refund:${r.orderGroupId}`, payment_intent_id: intent.id });
    expect(await new LateRefundConsumer(w.raw, w.fakes.refunds).handle(ev)).toBe("processed");
    expect(w.fakes.refunds.requests.length).toBe(refunds + 1);
    expect(w.fakes.refunds.requests.at(-1)).toMatchObject({ orderGroupId: r.orderGroupId, reason: "late_payment_unavailable", idempotencyKey: `late_refund:${r.orderGroupId}` });
    expect(await w.outboxTypes()).toContain("order_group.late_payment_refund");
    const e = await w.raw.query<{ kind: string }>("SELECT kind FROM journal_entries WHERE idempotency_key = $1", [`late_refund:${r.orderGroupId}`]);
    expect(e.rows[0]?.kind).toBe("refund_issued");
    expect(await trial()).toBe(0n);
  });

  it("the sweeper leaves a group alone when the PSP says the money already moved", async () => {
    const sku = await w.seedSku(w.stores[0], 25_000n);
    const u = await w.newUser();
    await w.fillBag(u, [{ sku, qty: 1 }]);
    const r = await (await quoteAndPlace(w, u, "card")).place();
    await expireNow(r.orderGroupId);
    w.fakes.provider.nextVoid = "already_captured";
    try {
      expect((await w.sweeper.run()).leftForWebhook).toContain(r.orderGroupId);
    } finally {
      w.fakes.provider.nextVoid = "voided";
    }
    expect(await status(r.orderGroupId)).toBe("PENDING_PAYMENT");
  });
});

describe("failure compensation", () => {
  it("split tender: a failed external payment releases the credit hold, the reservation and the group", async () => {
    const sku = await w.seedSku(w.stores[0], 100_000n, 2);
    const u = await w.newUser();
    await w.grantCredit(u, 50_000n);
    await w.fillBag(u, [{ sku, qty: 1 }]);
    const r = await (await quoteAndPlace(w, u, "card", { creditRequested: money(30_000n, "EGP") })).place();
    const held = await w.raw.query<{ status: string; amount_minor: string }>("SELECT status, amount_minor::text FROM ledger_holds WHERE ref_id = $1", [r.orderGroupId]);
    expect(held.rows).toEqual([{ status: "HELD", amount_minor: "30000" }]);
    const intent = await intentOf(w, r.orderGroupId);
    expect(BigInt(intent.amount_minor)).toBe(100_000n - 30_000n); // 100,000 (store A delivers free in this suite) - credit
    // C1: a webhook decline on an external method is not final: nothing is released until the payment window closes
    expect(await w.webhooks.handle(paidWebhook(w, intent, `fail-${r.orderGroupId}`, "payment.failed"))).toMatchObject({ outcome: "processed", detail: "payment_attempt_failed" });
    expect(await status(r.orderGroupId)).toBe("PENDING_PAYMENT");
    expect((await w.raw.query<{ status: string }>("SELECT status FROM ledger_holds WHERE ref_id = $1", [r.orderGroupId])).rows[0]?.status).toBe("HELD");
    await w.raw.query("UPDATE order_groups SET payment_expires_at = now() - interval '1 minute' WHERE id = $1", [r.orderGroupId]);
    expect((await w.sweeper.run()).expired).toContain(r.orderGroupId);
    w.clock.t += 11 * 60_000;
    await w.reservations.sweepExpired(new Date(w.clock.t));
    expect((await w.raw.query<{ status: string }>("SELECT status FROM ledger_holds WHERE ref_id = $1", [r.orderGroupId])).rows[0]?.status).toBe("EXPIRED");
    expect(await status(r.orderGroupId)).toBe("EXPIRED");
    expect((await w.raw.query<{ state: string }>("SELECT state FROM reservations WHERE order_group_ref = $1", [r.orderGroupId])).rows[0]?.state).toBe("EXPIRED");
    const again = await w.svc.quote(u, { addressRef: ADDR, method: "card", creditRequested: money(50_000n, "EGP") });
    expect(again.quote.storeCredit.amountMinor).toBe(50_000n);
  });

  it("split tender success captures the hold inside the same ledger entry", async () => {
    const sku = await w.seedSku(w.stores[0], 100_000n, 2);
    const u = await w.newUser();
    await w.grantCredit(u, 50_000n);
    await w.fillBag(u, [{ sku, qty: 1 }]);
    const r = await (await quoteAndPlace(w, u, "card", { creditRequested: money(30_000n, "EGP") })).place();
    expect(await w.webhooks.handle(paidWebhook(w, await intentOf(w, r.orderGroupId), `ok-${r.orderGroupId}`))).toMatchObject({ detail: "paid" });
    const s = await sumBy(r.orderGroupId);
    expect(s.get(`store_credit:EG:EGP:${u}:goodwill`)).toBe(30_000n);
    expect(s.get("psp_clearing:EG:EGP:paymob")).toBe(70_000n);
    expect((await w.raw.query<{ status: string; captured_entry_id: string | null }>("SELECT status, captured_entry_id FROM ledger_holds WHERE ref_id = $1", [r.orderGroupId])).rows[0]?.status).toBe("CAPTURED");
    expect(await trial()).toBe(0n);
  });

  it("a non-retryable PSP decline fails the group (402) and frees the stock; a timeout resumes with the same key", async () => {
    const sku = await w.seedSku(w.stores[2], 40_000n, 1);
    const u = await w.newUser();
    await w.fillBag(u, [{ sku, qty: 1 }]);
    w.fakes.provider.nextCreate = "decline";
    const a = await quoteAndPlace(w, u, "card");
    expect(await errCode(a.place())).toBe("payment-declined");
    w.fakes.provider.nextCreate = "requires_action";
    const g = (await w.raw.query<{ id: string; status: string }>("SELECT id, status FROM order_groups WHERE user_id = $1", [u])).rows[0];
    expect(g?.status).toBe("PAYMENT_FAILED");
    expect((await w.raw.query<{ state: string }>("SELECT state FROM reservations WHERE order_group_ref = $1", [g?.id ?? ""])).rows[0]?.state).toBe("RELEASED");

    const u2 = await w.newUser();
    await w.fillBag(u2, [{ sku, qty: 1 }]);
    w.fakes.provider.nextCreate = "timeout";
    const b = await quoteAndPlace(w, u2, "card");
    expect(await errCode(b.place())).toBe("psp-unavailable");
    w.fakes.provider.nextCreate = "requires_action";
    const resumed = await b.place();
    expect(resumed).toMatchObject({ status: "PENDING_PAYMENT", replayed: true });
    expect(resumed.clientAction.kind).toBe("redirect");
    expect(w.fakes.provider.createCalls.at(-1)?.key).toBe(resumed.orderGroupId);
    expect(w.fakes.provider.createCalls.at(-2)?.key).toBe(resumed.orderGroupId);
  });

  it("price changed since the quote: 409 with the delta list and a fresh quote; nothing is written", async () => {
    const sku = await w.seedSku(w.stores[0], 50_000n);
    const u = await w.newUser();
    await w.fillBag(u, [{ sku, qty: 1 }]);
    const { place, q } = await quoteAndPlace(w, u, "card");
    await w.raw.query("UPDATE catalog_public_listings SET variants = jsonb_set(variants, '{0,price_minor}', '\"55000\"') WHERE id = $1", [sku.productId]);
    let caught: unknown;
    try { await place(); } catch (e) { caught = e; }
    expect(caught).toMatchObject({ code: "price-changed", status: 409 });
    const d = (caught as { details: { deltas: { kind: string }[]; fresh: { total: { amountMinor: bigint } } } }).details;
    expect(d.deltas.map((x) => x.kind)).toEqual(expect.arrayContaining(["line_price", "total"]));
    expect(d.fresh.total.amountMinor).toBe(q.quote.total.amountMinor + 5_000n);
    expect(await groupCount(u)).toBe(0);
    expect((await w.raw.query("SELECT 1 FROM reservations WHERE user_id = $1", [u])).rows).toHaveLength(0);
  });

  it("stock taken by someone else between quote and place: 409 stock-shortfall with the shortfall and no group", async () => {
    const sku = await w.seedSku(w.stores[1], 12_000n, 1);
    const u = await w.newUser();
    await w.fillBag(u, [{ sku, qty: 1 }]);
    const { place } = await quoteAndPlace(w, u, "card");
    const other = await w.newUser();
    await w.reservations.reserve({ orderGroupRef: `hold-${sku.skuId}`, userId: other, items: [{ skuId: sku.skuId, locationId: (await w.raw.query<{ id: string }>("SELECT id FROM inventory_locations WHERE store_id = $1", [sku.storeId])).rows[0]?.id ?? "", storeId: sku.storeId, qty: 1 }] });
    let caught: unknown;
    try { await place(); } catch (e) { caught = e; }
    expect(caught).toMatchObject({ code: "stock-shortfall", status: 409 });
    expect((caught as { details: { shortfalls: unknown[] } }).details.shortfalls).toHaveLength(1);
    expect(await groupCount(u)).toBe(0);
  });
});

describe("cash on delivery and store credit only", () => {
  it("COD skips the PSP: CONFIRMED_COD, stock claimed at once, nothing posted to the ledger", async () => {
    const sku = await w.seedSku(w.stores[0], 20_000n, 2);
    const u = await w.newUser();
    await w.fillBag(u, [{ sku, qty: 1 }]);
    const calls = w.fakes.provider.createCalls.length;
    const r = await (await quoteAndPlace(w, u, "cod")).place();
    expect(r.status).toBe("CONFIRMED_COD");
    expect(r.clientAction).toEqual({ kind: "none" });
    expect(w.fakes.provider.createCalls.length).toBe(calls);
    expect((await intentOf(w, r.orderGroupId)).status).toBe("NOT_REQUIRED");
    expect(await w.free(sku)).toBe(1);
    expect((await w.raw.query("SELECT 1 FROM journal_entries WHERE ref_id = $1", [r.orderGroupId])).rows).toHaveLength(0);
    expect((await w.svc.getOrderGroup(u, r.orderGroupId)).sellerOrders[0]?.status).toBe("CONFIRMED_COD");
  });

  it("COD risk: require_confirmation waits, confirmCod claims; block and prepaid_only are 403; credit with COD is 422", async () => {
    const sku = await w.seedSku(w.stores[0], 20_000n, 3);
    const u = await w.newUser();
    await w.fillBag(u, [{ sku, qty: 1 }]);
    w.fakes.risk.decision = "require_confirmation";
    const r = await (await quoteAndPlace(w, u, "cod")).place();
    expect(r.status).toBe("AWAITING_COD_CONFIRMATION");
    expect(r.clientAction.kind).toBe("cod_confirmation");
    expect(await w.free(sku)).toBe(3);
    expect(await w.svc.confirmCod(u, r.orderGroupId)).toEqual({ status: "CONFIRMED_COD" });
    expect(await w.free(sku)).toBe(2);
    expect(await errCode(w.svc.confirmCod(u, r.orderGroupId))).toBe("invalid-state");

    const u2 = await w.newUser();
    await w.fillBag(u2, [{ sku, qty: 1 }]);
    for (const d of ["block", "prepaid_only"] as const) {
      w.fakes.risk.decision = d;
      expect(await errCode((await quoteAndPlace(w, u2, "cod")).place())).toBe("cod-not-allowed");
    }
    w.fakes.risk.decision = "allow";
    expect(await errCode(w.svc.quote(u2, { addressRef: ADDR, method: "cod", creditRequested: money(100n, "EGP") }))).toBe("cod-credit-unsupported");
    expect(await groupCount(u2)).toBe(0);
  });

  it("an unconfirmed COD order expires and its reservation is released", async () => {
    const sku = await w.seedSku(w.stores[0], 20_000n, 1);
    const u = await w.newUser();
    await w.fillBag(u, [{ sku, qty: 1 }]);
    w.fakes.risk.decision = "require_confirmation";
    const r = await (await quoteAndPlace(w, u, "cod")).place();
    w.fakes.risk.decision = "allow";
    await w.raw.query("UPDATE order_groups SET payment_expires_at = now() - interval '1 minute' WHERE id = $1", [r.orderGroupId]);
    expect((await w.sweeper.run()).expired).toContain(r.orderGroupId);
    expect(await status(r.orderGroupId)).toBe("EXPIRED");
    expect((await w.raw.query<{ state: string }>("SELECT state FROM reservations WHERE order_group_ref = $1", [r.orderGroupId])).rows[0]?.state).toBe("RELEASED");
  });

  it("store credit only: paid at placement, one balanced entry debiting the credit, no PSP call", async () => {
    const sku = await w.seedSku(w.stores[1], 20_000n, 2);
    const u = await w.newUser();
    await w.grantCredit(u, 100_000n);
    await w.fillBag(u, [{ sku, qty: 1 }]);
    const calls = w.fakes.provider.createCalls.length;
    const r = await (await quoteAndPlace(w, u, "store_credit")).place();
    expect(r.status).toBe("PAID");
    expect(w.fakes.provider.createCalls.length).toBe(calls);
    const s = await sumBy(r.orderGroupId);
    expect(s.get(`store_credit:EG:EGP:${u}:goodwill`)).toBe(26_000n);
    expect([...s.keys()].some((k) => k.startsWith("psp_clearing"))).toBe(false);
    expect(await trial()).toBe(0n);
    const poor = await w.newUser();
    await w.fillBag(poor, [{ sku, qty: 1 }]);
    expect(await errCode((await quoteAndPlace(w, poor, "store_credit")).place())).toBe("credit-insufficient");
    expect(await groupCount(poor)).toBe(0);
  });
});

describe("quote", () => {
  it("every fee is on the first render: delivery per store and the fee of every offered method", async () => {
    const svc = w.makeSvc({ methodFee: { ...Object.fromEntries(PAYMENT_METHODS.map((m) => [m, money(0n, "EGP")])), card: money(1500n, "EGP"), fawry: money(500n, "EGP") } as Record<PaymentMethod, ReturnType<typeof money>> });
    const [A, B] = w.stores;
    const sA = await w.seedSku(A, 10_000n); const sB = await w.seedSku(B, 10_000n);
    const u = await w.newUser();
    await w.fillBag(u, [{ sku: sA, qty: 1 }, { sku: sB, qty: 1 }]);
    const { quote: q } = await svc.quote(u, { addressRef: ADDR, method: "instapay" });
    expect(q.fees.filter((f) => f.code === "delivery")).toHaveLength(2);
    // C8: the ledger cannot book a method fee yet, so fee-bearing methods are excluded from the quote instead of shown and refused later
    const fees = q.fees.filter((f) => f.code === "payment_method");
    expect(fees.map((f) => f.method).sort()).toEqual(PAYMENT_METHODS.filter((m) => m !== "card" && m !== "fawry").sort());
    expect(q.payableByMethod.has("card")).toBe(false);
    expect(q.payableByMethod.has("fawry")).toBe(false);
    expect(q.payableByMethod.get("instapay")?.amountMinor).toBe(q.total.amountMinor);
    expect(await errCode(svc.quote(u, { addressRef: ADDR, method: "card" }))).toBe("method-unavailable");
  });

  it("'you saved' counts only verified VRP snapshots (an unverified or lower reference saves nothing)", async () => {
    const [A] = w.stores;
    const verified = await w.seedSku(A, 8_000n); const unverified = await w.seedSku(A, 5_000n); const lower = await w.seedSku(A, 5_000n);
    w.fakes.prices.snapshots.set(verified.skuId, { vrp: money(10_000n, "EGP"), evidenceIds: ["01900000-0000-7000-8000-0000000000e1"], claimType: "verified_discount" });
    w.fakes.prices.snapshots.set(unverified.skuId, { vrp: money(9_000n, "EGP"), evidenceIds: [], claimType: "plain" });
    w.fakes.prices.snapshots.set(lower.skuId, { vrp: money(4_000n, "EGP"), evidenceIds: [], claimType: "verified_discount" });
    const u = await w.newUser();
    await w.fillBag(u, [{ sku: verified, qty: 2 }, { sku: unverified, qty: 1 }, { sku: lower, qty: 1 }]);
    const { quote: q } = await w.svc.quote(u, { addressRef: ADDR, method: "card" });
    expect(q.verifiedSavings.amountMinor).toBe(4_000n); // (10,000 - 8,000) x 2
    const r = await (await quoteAndPlace(w, u, "card")).place();
    const rows = (await w.raw.query<{ sku_id: string; claim_type_snapshot: string; vrp_minor_snapshot: string | null }>("SELECT sku_id, claim_type_snapshot, vrp_minor_snapshot::text FROM order_lines WHERE order_group_id = $1", [r.orderGroupId])).rows;
    expect(rows.find((x) => x.sku_id === verified.skuId)).toMatchObject({ claim_type_snapshot: "verified_discount", vrp_minor_snapshot: "10000" });
    expect(rows.find((x) => x.sku_id === lower.skuId)).toMatchObject({ claim_type_snapshot: "plain", vrp_minor_snapshot: null });
  });

  it("stays within the statement budget 6 + S + 2K (S stores, K skus)", async () => {
    const skus = [await w.seedSku(w.stores[0], 10_000n), await w.seedSku(w.stores[1], 10_000n), await w.seedSku(w.stores[2], 10_000n)];
    const u = await w.newUser();
    await w.fillBag(u, skus.map((sku) => ({ sku, qty: 1 })));
    const before = w.statements.length;
    await w.svc.quote(u, { addressRef: ADDR, method: "card" });
    const used = w.statements.length - before;
    expect(used).toBeLessThanOrEqual(6 + 3 + 2 * 3);
  });

  it("is pure: quoting writes nothing", async () => {
    const sku = await w.seedSku(w.stores[0], 10_000n);
    const u = await w.newUser();
    await w.fillBag(u, [{ sku, qty: 1 }]);
    await w.svc.quote(u, { addressRef: ADDR, method: "card" });
    expect(await groupCount(u)).toBe(0);
    expect((await w.raw.query("SELECT 1 FROM checkout_sessions WHERE user_id = $1", [u])).rows).toHaveLength(0);
    expect((await w.raw.query("SELECT 1 FROM reservations WHERE user_id = $1", [u])).rows).toHaveLength(0);
  });

  it("a forged or foreign quote token is 422; an unknown address is 404; an empty bag is 422", async () => {
    const sku = await w.seedSku(w.stores[0], 10_000n);
    const u = await w.newUser();
    await w.fillBag(u, [{ sku, qty: 1 }]);
    const q = await w.svc.quote(u, { addressRef: ADDR, method: "card" });
    const base = { addressRef: ADDR, method: "card" as const, idempotencyKey: "01900000-0000-7000-8000-000000000f02", quote: q.quote };
    expect(await errCode(w.svc.place(u, { ...base, quoteToken: `${q.token}x` }))).toBe("quote-token-invalid");
    const other = await w.newUser();
    expect(await errCode(w.svc.place(other, { ...base, quoteToken: q.token }))).toBe("quote-token-invalid");
    const tampered = { ...q.quote, total: money(1n, "EGP") };
    expect(await errCode(w.svc.place(u, { ...base, quote: tampered, quoteToken: q.token }))).toBe("quote-token-invalid");
    w.fakes.address.open = false;
    try { expect(await errCode(w.svc.quote(u, { addressRef: ADDR, method: "card" }))).toBe("address-not-found"); } finally { w.fakes.address.open = true; }
    expect(await errCode(w.svc.quote(await w.newUser(), { addressRef: ADDR, method: "card" }))).toBe("empty-bag");
  });

  it("an expired quote is 409 quote-expired with a fresh quote", async () => {
    const sku = await w.seedSku(w.stores[0], 10_000n);
    const u = await w.newUser();
    await w.fillBag(u, [{ sku, qty: 1 }]);
    const { place } = await quoteAndPlace(w, u, "card");
    w.clock.t += 601_000;
    let caught: unknown;
    try { await place(); } catch (e) { caught = e; }
    expect(caught).toMatchObject({ code: "quote-expired", status: 409 });
    expect((caught as { details: { fresh?: unknown } }).details.fresh).toBeDefined();
  });
});

describe("kill switches fail closed", () => {
  it.each(PAYMENT_METHODS.map((m) => [m]))("%s: an engaged switch removes the method from the quote and refuses placement (403)", async (m) => {
    const sku = await w.seedSku(w.stores[0], 10_000n);
    const u = await w.newUser();
    await w.grantCredit(u, 50_000n);
    await w.fillBag(u, [{ sku, qty: 1 }]);
    const open = await quoteAndPlace(w, u, m);
    expect(open.q.quote.payableByMethod.has(m)).toBe(true);
    w.fakes.kill.engaged.add(KILL_SWITCH_OF[m]);
    try {
      expect(await errCode(open.place())).toBe("method-unavailable");
      expect(await errCode(w.svc.quote(u, { addressRef: ADDR, method: m }))).toBe("method-unavailable");
      const other = m === "card" ? "instapay" : "card";
      expect((await w.svc.quote(u, { addressRef: ADDR, method: other })).quote.payableByMethod.has(m)).toBe(false);
    } finally {
      w.fakes.kill.engaged.delete(KILL_SWITCH_OF[m]);
    }
    expect(await groupCount(u)).toBe(0);
  });

  it("a webhook is still processed with the method's switch engaged (the money already moved)", async () => {
    const sku = await w.seedSku(w.stores[0], 10_000n);
    const u = await w.newUser();
    await w.fillBag(u, [{ sku, qty: 1 }]);
    const r = await (await quoteAndPlace(w, u, "card")).place();
    w.fakes.kill.engaged.add(KILL_SWITCH_OF.card);
    try {
      expect(await w.webhooks.handle(paidWebhook(w, await intentOf(w, r.orderGroupId), `ks-${r.orderGroupId}`))).toMatchObject({ detail: "paid" });
    } finally {
      w.fakes.kill.engaged.delete(KILL_SWITCH_OF.card);
    }
  });

  it("a store without a PSP sub-merchant account fails closed for external methods (409) but COD still works", async () => {
    const sku = await w.seedSku(w.stores[2], 10_000n, 3);
    const u = await w.newUser();
    await w.fillBag(u, [{ sku, qty: 1 }]);
    w.fakes.subs.missing.add(w.stores[2]);
    try {
      expect(await errCode((await quoteAndPlace(w, u, "card")).place())).toBe("store-not-onboarded");
      expect((await (await quoteAndPlace(w, u, "cod")).place()).status).toBe("CONFIRMED_COD");
    } finally {
      w.fakes.subs.missing.delete(w.stores[2]);
    }
  });
});

describe("tenant isolation", () => {
  it("shopper B cannot read shopper A's order group (not-found, never 403)", async () => {
    const sku = await w.seedSku(w.stores[0], 10_000n);
    const a = await w.newUser(); const b = await w.newUser();
    await w.fillBag(a, [{ sku, qty: 1 }]);
    const r = await (await quoteAndPlace(w, a, "card")).place();
    expect((await w.svc.getOrderGroup(a, r.orderGroupId)).id).toBe(r.orderGroupId);
    expect(await errCode(w.svc.getOrderGroup(b, r.orderGroupId))).toBe("not-found");
    expect(await errCode(w.svc.confirmCod(b, r.orderGroupId))).toBe("not-found");
  });

  it("seller A reads its own seller order but not seller B's (not-found)", async () => {
    const [A, B] = w.stores;
    const sA = await w.seedSku(A, 10_000n); const sB = await w.seedSku(B, 10_000n);
    const u = await w.newUser();
    await w.fillBag(u, [{ sku: sA, qty: 1 }, { sku: sB, qty: 1 }]);
    const r = await (await quoteAndPlace(w, u, "card")).place();
    const view = await w.svc.getOrderGroup(u, r.orderGroupId);
    const soA = view.sellerOrders.find((x) => x.storeId === A)?.id ?? "";
    const soB = view.sellerOrders.find((x) => x.storeId === B)?.id ?? "";
    expect((await w.svc.getSellerOrder(A, soA)).storeId).toBe(A);
    expect(await errCode(w.svc.getSellerOrder(A, soB))).toBe("not-found");
    expect(await errCode(w.svc.getSellerOrder(B, soA))).toBe("not-found");
    expect(await errCode(w.svc.getSellerOrder(w.stores[2], soA))).toBe("not-found");
  });

  it("the webhook processor cannot be used as the shopper app role: raw events are unreadable by outlet_app", async () => {
    const { roleClient } = await import("@outlet/db/testing");
    await expect(roleClient(w.raw, "outlet_app").query("SELECT 1 FROM payment_events_raw")).rejects.toThrow();
  });
});

const outboxRows = async (type: string, groupId: string): Promise<{ payload: Record<string, unknown> }[]> =>
  (await w.raw.query<{ payload: Record<string, unknown> }>("SELECT payload FROM outbox_events WHERE event_type = $1 AND (payload ->> 'order_group_id' = $2 OR payload ->> 'groupId' = $2)", [type, groupId])).rows;

describe("C1: a declined attempt on an external method is not final", () => {
  it("declined then succeeded within the window: PAID, claimed, no refund", async () => {
    const sku = await w.seedSku(w.stores[0], 25_000n, 2);
    const u = await w.newUser();
    await w.fillBag(u, [{ sku, qty: 1 }]);
    const r = await (await quoteAndPlace(w, u, "card")).place();
    const intent = await intentOf(w, r.orderGroupId);
    const failed = w.fakes.provider.webhook({ id: `c1-fail-${r.orderGroupId}`, type: "payment.failed", merchantReference: intent.id, providerRef: "attempt-1", amountMinor: BigInt(intent.amount_minor), failureCode: "insufficient_funds" });
    expect(await w.webhooks.handle(failed)).toMatchObject({ outcome: "processed", detail: "payment_attempt_failed" });
    expect(await status(r.orderGroupId)).toBe("PENDING_PAYMENT");
    const after = await w.raw.query<{ status: string; failure_code: string | null; provider_ref: string | null }>("SELECT status, failure_code, provider_ref FROM payment_intents WHERE id = $1", [intent.id]);
    expect(after.rows[0]).toEqual({ status: "REQUIRES_ACTION", failure_code: "insufficient_funds", provider_ref: intent.provider_ref });
    expect((await w.raw.query<{ state: string }>("SELECT state FROM reservations WHERE order_group_ref = $1", [r.orderGroupId])).rows[0]?.state).toBe("ACTIVE");
    expect(await outboxRows("order_group.payment_attempt_failed", r.orderGroupId)).toHaveLength(1);
    expect(await outboxRows("order_group.payment_failed", r.orderGroupId)).toHaveLength(0);
    const refunds = w.fakes.refunds.requests.length;
    expect(await w.webhooks.handle(paidWebhook(w, intent, `c1-ok-${r.orderGroupId}`))).toMatchObject({ outcome: "processed", detail: "paid" });
    expect(await status(r.orderGroupId)).toBe("PAID");
    expect((await intentOf(w, r.orderGroupId)).status).toBe("CAPTURED");
    expect(await outboxRows("order_group.late_payment_refund", r.orderGroupId)).toHaveLength(0);
    expect(w.fakes.refunds.requests.length).toBe(refunds);
    expect(await w.free(sku)).toBe(1);
    expect(await trial()).toBe(0n);
  });
});

describe("C2: capture integrity", () => {
  it("a second payment.succeeded with another provider reference on a PAID group is a duplicate capture: rejected, event emitted, nothing posted twice", async () => {
    const sku = await w.seedSku(w.stores[0], 25_000n, 2);
    const u = await w.newUser();
    await w.fillBag(u, [{ sku, qty: 1 }]);
    const r = await (await quoteAndPlace(w, u, "card")).place();
    const intent = await intentOf(w, r.orderGroupId);
    await w.webhooks.handle(paidWebhook(w, intent, `c2-a-${r.orderGroupId}`));
    const second = w.fakes.provider.webhook({ id: `c2-b-${r.orderGroupId}`, type: "payment.succeeded", merchantReference: intent.id, providerRef: "psp-second-capture", amountMinor: BigInt(intent.amount_minor) });
    expect(await w.webhooks.handle(second)).toEqual({ outcome: "rejected", reason: "duplicate_capture" });
    expect(await status(r.orderGroupId)).toBe("PAID");
    const ev = await outboxRows("payment.webhook_rejected", r.orderGroupId);
    expect(ev.map((e) => e.payload)).toEqual([expect.objectContaining({ reason: "duplicate_capture", groupId: r.orderGroupId, providerRef: "psp-second-capture" })]);
    expect((await w.raw.query("SELECT 1 FROM journal_entries WHERE idempotency_key = $1", [`order_paid:${r.orderGroupId}`])).rows).toHaveLength(1);
    expect((await w.raw.query<{ processing_status: string }>("SELECT processing_status FROM payment_events_raw WHERE provider_event_id = $1", [`c2-b-${r.orderGroupId}`])).rows[0]?.processing_status).toBe("rejected");
  });

  it("a capture whose provider reference differs from the intent's on an unsettled group is provider_ref_mismatch: rejected, event emitted, order untouched", async () => {
    const sku = await w.seedSku(w.stores[0], 25_000n, 2);
    const u = await w.newUser();
    await w.fillBag(u, [{ sku, qty: 1 }]);
    const r = await (await quoteAndPlace(w, u, "card")).place();
    const intent = await intentOf(w, r.orderGroupId);
    const bad = w.fakes.provider.webhook({ id: `c2-m-${r.orderGroupId}`, type: "payment.succeeded", merchantReference: intent.id, providerRef: "psp-someone-else", amountMinor: BigInt(intent.amount_minor) });
    expect(await w.webhooks.handle(bad)).toEqual({ outcome: "rejected", reason: "provider_ref_mismatch" });
    expect(await status(r.orderGroupId)).toBe("PENDING_PAYMENT");
    expect((await intentOf(w, r.orderGroupId)).provider_ref).toBe(intent.provider_ref);
    expect((await outboxRows("payment.webhook_rejected", r.orderGroupId)).map((e) => e.payload)).toEqual([expect.objectContaining({ reason: "provider_ref_mismatch", groupId: r.orderGroupId, providerRef: "psp-someone-else" })]);
    expect(await w.webhooks.handle(paidWebhook(w, intent, `c2-ok-${r.orderGroupId}`))).toMatchObject({ detail: "paid" });
  });
});

describe("C4: LateRefundConsumer", () => {
  it("a failing port keeps the event unprocessed (group stays REFUND_PENDING), the retry succeeds once, a redelivery is a duplicate", async () => {
    const sku = await w.seedSku(w.stores[2], 25_000n, 1);
    const u = await w.newUser();
    await w.fillBag(u, [{ sku, qty: 1 }]);
    const r = await (await quoteAndPlace(w, u, "card")).place();
    const intent = await intentOf(w, r.orderGroupId);
    await w.raw.query("UPDATE order_groups SET payment_expires_at = now() - interval '1 minute' WHERE id = $1", [r.orderGroupId]);
    await w.sweeper.run();
    w.clock.t += 11 * 60_000;
    await w.reservations.sweepExpired(new Date(w.clock.t));
    const other = await w.newUser();
    await w.fillBag(other, [{ sku, qty: 1 }]);
    await (await quoteAndPlace(w, other, "cod")).place();
    expect(await w.webhooks.handle(paidWebhook(w, intent, `c4-${r.orderGroupId}`))).toMatchObject({ detail: "late_refund" });
    const ev = await lateRefundEvent(r.orderGroupId);
    const inboxCount = async (): Promise<number> => (await w.raw.query("SELECT 1 FROM inbox_processed WHERE consumer = 'checkout.late_refund' AND message_id = $1", [ev.id])).rows.length;

    let calls = 0;
    const flaky: ConstructorParameters<typeof LateRefundConsumer>[1] = { requestRefund: () => { calls += 1; return Promise.resolve({ accepted: false }); } };
    await expect(new LateRefundConsumer(w.raw, flaky).handle(ev)).rejects.toMatchObject({ code: "psp-unavailable" });
    expect(await status(r.orderGroupId)).toBe("REFUND_PENDING");
    expect(await inboxCount()).toBe(0);

    const port = new RecordingRefunds();
    const consumer = new LateRefundConsumer(w.raw, port);
    expect(await consumer.handle(ev)).toBe("processed");
    expect(port.requests).toHaveLength(1);
    expect(port.requests[0]).toMatchObject({ orderGroupId: r.orderGroupId, paymentIntentId: intent.id, reason: "late_payment_unavailable", idempotencyKey: `late_refund:${r.orderGroupId}` });
    expect(port.requests[0]?.amount.amountMinor).toBe(BigInt(intent.amount_minor));
    expect(await inboxCount()).toBe(1);
    expect(await consumer.handle(ev)).toBe("duplicate");
    expect(port.requests).toHaveLength(1);
    expect(calls).toBe(1);
    expect(await status(r.orderGroupId)).toBe("REFUND_PENDING");
  });
});

describe("C6: COD first-order floor and fail-closed risk", () => {
  it("an order above codMaxFirstOrder is refused even when the risk port says allow, and the risk port is not consulted", async () => {
    const sku = await w.seedSku(w.stores[0], 160_000n, 2);
    const u = await w.newUser();
    await w.fillBag(u, [{ sku, qty: 1 }]);
    w.fakes.risk.decision = "allow";
    const calls = w.fakes.risk.calls;
    let caught: unknown;
    try { await (await quoteAndPlace(w, u, "cod")).place(); } catch (e) { caught = e; }
    expect(caught).toMatchObject({ code: "cod-not-allowed", status: 403, details: { riskDecision: "limit_value" } });
    expect(w.fakes.risk.calls).toBe(calls);
    expect(await groupCount(u)).toBe(0);
  });

  it("an order exactly at the cap still goes through the risk port", async () => {
    const sku = await w.seedSku(w.stores[0], 144_000n, 2); // + 6,000 delivery = 150,000
    const u = await w.newUser();
    await w.fillBag(u, [{ sku, qty: 1 }]);
    w.fakes.risk.decision = "allow";
    expect((await (await quoteAndPlace(w, u, "cod")).place()).status).toBe("CONFIRMED_COD");
  });

  it("UnconfiguredRisk blocks, and a service wired without a risk port refuses COD", async () => {
    expect(await new UnconfiguredRisk().assessCod()).toEqual({ decision: "block", reasonCodes: ["risk_unconfigured"] });
    const { CheckoutService, PgStoreCredit } = await import("../src/index.js");
    const { FakeBilling, FakeTaxCategories, defaultConfig } = await import("../src/testing.js");
    const { InMemoryTaxRateProvider } = await import("@outlet/tax");
    const svc = new CheckoutService({
      marketId: "EG", now: () => new Date(w.clock.t), config: defaultConfig(), reservations: w.reservations, provider: w.fakes.provider, shipping: w.fakes.shipping, address: w.fakes.address,
      commission: w.fakes.commission, taxCategories: new FakeTaxCategories(), taxRates: InMemoryTaxRateProvider.withMarketDefaults(["eg"]), credit: new PgStoreCredit("EGP"), tokens: new HmacQuoteTokens(),
      prices: w.fakes.prices, killSwitches: w.fakes.kill, subMerchants: w.fakes.subs, billing: new FakeBilling(), refunds: w.fakes.refunds, client: w.app,
    });
    const sku = await w.seedSku(w.stores[0], 20_000n, 2);
    const u = await w.newUser();
    await w.fillBag(u, [{ sku, qty: 1 }]);
    const q = await svc.quote(u, { addressRef: ADDR, method: "cod" });
    let caught: unknown;
    try { await svc.place(u, { addressRef: ADDR, method: "cod", idempotencyKey: uuidv7(), quoteToken: q.token, quote: q.quote }); } catch (e) { caught = e; }
    expect(caught).toMatchObject({ code: "cod-not-allowed", details: { riskDecision: "block" } });
  });
});

describe("C7, C10, C9: placement hardening", () => {
  it("the same quote token with a second Idempotency-Key is a typed 409 quote-token-invalid, never a raw database error", async () => {
    const sku = await w.seedSku(w.stores[0], 10_000n, 3);
    const u = await w.newUser();
    await w.fillBag(u, [{ sku, qty: 1 }]);
    const q = await w.svc.quote(u, { addressRef: ADDR, method: "card" });
    const base = { addressRef: ADDR, method: "card" as const, quoteToken: q.token, quote: q.quote };
    await w.svc.place(u, { ...base, idempotencyKey: uuidv7() });
    let caught: unknown;
    try { await w.svc.place(u, { ...base, idempotencyKey: uuidv7() }); } catch (e) { caught = e; }
    expect(caught).toMatchObject({ code: "quote-token-invalid", status: 409, name: "CheckoutError" });
    expect(await groupCount(u)).toBe(1);
  });

  it("a bag line outside 1..10 is a 422 invalid-quantity, not a CHECK violation", async () => {
    const sku = await w.seedSku(w.stores[0], 10_000n, 20);
    const u = await w.newUser();
    await w.fillBag(u, [{ sku, qty: 1 }]);
    await w.raw.query("ALTER TABLE cart_lines DROP CONSTRAINT cart_lines_qty_check");
    try {
      await w.raw.query("UPDATE cart_lines SET qty = 11 WHERE user_id = $1", [u]);
      let caught: unknown;
      try { await w.svc.quote(u, { addressRef: ADDR, method: "card" }); } catch (e) { caught = e; }
      expect(caught).toMatchObject({ code: "invalid-quantity", status: 422 });
      await w.raw.query("UPDATE cart_lines SET qty = 0 WHERE user_id = $1", [u]);
      expect(await errCode(w.svc.quote(u, { addressRef: ADDR, method: "card" }))).toBe("invalid-quantity");
    } finally {
      await w.raw.query("UPDATE cart_lines SET qty = 1 WHERE user_id = $1", [u]);
      await w.raw.query("ALTER TABLE cart_lines ADD CONSTRAINT cart_lines_qty_check CHECK (qty BETWEEN 1 AND 10)");
    }
  });

  it("quote tokens carry a kid, reject a malformed or unknown-kid payload, and verify with a rotated key", () => {
    const exp = new Date(Date.now() + 600_000);
    const p = { jti: "j", userId: "u", marketId: "EG", quoteHash: "h", method: "card" as const, expiresAt: exp };
    const old = new HmacQuoteTokens("secret-old", "k1");
    const rotated = new HmacQuoteTokens("secret-new", "k2", { k1: "secret-old" });
    const t = old.sign(p);
    expect(JSON.parse(Buffer.from(t.split(".")[0] ?? "", "base64url").toString("utf8"))).toMatchObject({ kid: "k1" });
    expect(rotated.verify(t)).toEqual(p);
    expect(new HmacQuoteTokens("secret-new", "k2").verify(t)).toBeNull();
    expect(old.verify(rotated.sign(p))).toBeNull();
    const bad = Buffer.from(JSON.stringify({ kid: "k1", jti: "j", userId: "u", marketId: "EG", quoteHash: "h", method: "bitcoin", expiresAt: exp.toISOString() })).toString("base64url");
    const mac = (b: string): string => createHmac("sha256", "secret-old").update(b).digest().toString("base64url");
    expect(old.verify(`${bad}.${mac(bad)}`)).toBeNull();
    const junk = Buffer.from("not json").toString("base64url");
    expect(old.verify(`${junk}.${mac(junk)}`)).toBeNull();
  });
});

describe("C12: eachStoreContext leaves no store access behind", () => {
  it("after the restore, a shopper transaction cannot read any seller order (it could inside the store context)", async () => {
    const sku = await w.seedSku(w.stores[0], 10_000n);
    const owner = await w.newUser();
    await w.fillBag(owner, [{ sku, qty: 1 }]);
    await (await quoteAndPlace(w, owner, "card")).place();
    const stranger = await w.newUser();
    const seen = await withDbContext(w.app, { kind: "user", marketId: "EG", userId: stranger }, async (tx) => {
      const count = async (): Promise<number> => Number((await tx.query<{ n: string }>("SELECT count(*)::text AS n FROM seller_orders")).rows[0]?.n ?? "0");
      const before = await count();
      const inside = await eachStoreContext(tx, "EG", [w.stores[0]], count);
      return { before, inside: inside.get(w.stores[0]), after: await count() };
    });
    expect(seen.before).toBe(0);
    expect(seen.inside).toBeGreaterThan(0);
    expect(seen.after).toBe(0);
  });
});
