import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ReturnView } from "../src/index.js";
import { buildWorld, errCode } from "./fixtures.js";
import type { Order, World } from "./fixtures.js";

let w: World;
beforeAll(async () => { w = await buildWorld(); });
afterAll(async () => { await w.close(); });

type Reason = Parameters<World["returns"]["request"]>[1]["reason"];
const photo = [randomUUID()];
const ask = (userId: string, o: Order, reason: Reason, idx = 0, qty = 1, extra: Partial<Parameters<World["returns"]["request"]>[1]> = {}): Promise<ReturnView> =>
  w.returns.request(userId, { items: [{ orderLineId: o.lineIds[idx] ?? "", qty }], reason, method: "pickup", idempotencyKey: randomUUID(), ...extra });
const accept = async (storeId: string, o: Order, ret: ReturnView, idx = 0): Promise<void> => {
  const s = w.seller(storeId);
  await w.returns.receive(s, storeId, ret.id);
  await w.returns.inspect(s, storeId, ret.id, { result: "accepted", items: [{ orderLineId: o.lineIds[idx] ?? "", condition: "as_new", restock: "restock" }] });
};
const refundRow = async (id: string): Promise<{ delivery: string; amount: string; status: string }> =>
  (await w.raw.query<{ delivery: string; amount: string; status: string }>("SELECT delivery_fee_minor::text AS delivery, amount_minor::text AS amount, status FROM refunds WHERE id = $1", [id])).rows[0] ?? { delivery: "", amount: "", status: "" };

describe("RefundService.createForReturn", () => {
  it("an accepted exchange moves no money: no refund row is created", async () => {
    const [storeId] = w.stores;
    const u = await w.newUser();
    const o = await w.order({ userId: u, storeId, lines: [{ price: 10_000n }], deliveredDaysAgo: 1 });
    w.fakes.policy.swap = true;
    const ret = await ask(u, o, "too_small");
    w.fakes.policy.swap = false;
    expect(ret.resolution).toBe("exchange");
    await accept(storeId, o, ret);
    expect(await w.refunds.createForReturn(ret.id)).toBeNull();
    expect((await w.raw.query("SELECT 1 FROM refunds WHERE return_request_id = $1", [ret.id])).rows).toHaveLength(0);
  });

  it("refuses to refund when the stored commission no longer matches the order base (fail closed, nothing written)", async () => {
    const [storeId] = w.stores;
    const u = await w.newUser();
    const o = await w.order({ userId: u, storeId, lines: [{ price: 10_000n }], deliveredDaysAgo: 1 });
    const ret = await ask(u, o, "changed_mind");
    await accept(storeId, o, ret);
    await w.raw.query("UPDATE seller_orders SET commission_minor = commission_minor + 1 WHERE id = $1", [o.sellerOrderId]);
    expect(await errCode(w.refunds.createForReturn(ret.id))).toBe("commission_base_mismatch");
    expect((await w.raw.query("SELECT 1 FROM refunds WHERE return_request_id = $1", [ret.id])).rows).toHaveLength(0);
  });

  it("the delivery fee comes back once when the seller is at fault, not again on a later partial return of the same order", async () => {
    const [storeId] = w.stores;
    const u = await w.newUser();
    const o = await w.order({ userId: u, storeId, lines: [{ price: 10_000n }, { price: 8_000n }], shipping: 5_000n, shippingVat: 614n, deliveredDaysAgo: 2 });
    const first = await ask(u, o, "defect_undisclosed", 0, 1, { evidenceMediaIds: photo });
    await accept(storeId, o, first, 0);
    const r1 = await w.refunds.createForReturn(first.id);
    expect(r1).not.toBeNull();
    expect((await refundRow(r1?.id ?? "")).delivery).toBe("5000");
    const second = await ask(u, o, "defect_undisclosed", 1, 1, { evidenceMediaIds: photo });
    await accept(storeId, o, second, 1);
    const r2 = await w.refunds.createForReturn(second.id);
    expect((await refundRow(r2?.id ?? "")).delivery).toBe("0");
    expect(r2?.amount.amountMinor).toBe(8_000n);
  });

  it("a change-of-mind return keeps the delivery fee unless the whole order comes back; a full return within 7 days gets it", async () => {
    const [storeId] = w.stores;
    const u = await w.newUser();
    const partial = await w.order({ userId: u, storeId, lines: [{ price: 10_000n }, { price: 8_000n }], shipping: 5_000n, shippingVat: 614n, deliveredDaysAgo: 1 });
    const p = await ask(u, partial, "changed_mind", 0);
    await accept(storeId, partial, p, 0);
    expect((await refundRow((await w.refunds.createForReturn(p.id))?.id ?? "")).delivery).toBe("0");
    const whole = await w.order({ userId: u, storeId, lines: [{ price: 10_000n }], shipping: 5_000n, shippingVat: 614n, deliveredDaysAgo: 1 });
    const f = await ask(u, whole, "changed_mind", 0);
    await accept(storeId, whole, f, 0);
    expect((await refundRow((await w.refunds.createForReturn(f.id))?.id ?? "")).delivery).toBe("5000");
    const late = await w.order({ userId: u, storeId, lines: [{ price: 10_000n }], shipping: 5_000n, shippingVat: 614n, deliveredDaysAgo: 9 });
    const l = await ask(u, late, "changed_mind", 0);
    await accept(storeId, late, l, 0);
    expect((await refundRow((await w.refunds.createForReturn(l.id))?.id ?? "")).delivery).toBe("0");
  });
});

describe("RefundService.process waits", () => {
  const approved = async (): Promise<string> => {
    const [storeId] = w.stores;
    const u = await w.newUser();
    const o = await w.order({ userId: u, storeId, lines: [{ price: 10_000n }], deliveredDaysAgo: 1 });
    const ret = await ask(u, o, "changed_mind");
    await accept(storeId, o, ret);
    const r = await w.refunds.createForReturn(ret.id);
    return r?.id ?? "";
  };

  it("a refund parked in MANUAL_REVIEW is returned as is: no provider call, no ledger entry", async () => {
    const id = await approved();
    await w.raw.query("UPDATE refunds SET status = 'MANUAL_REVIEW' WHERE id = $1", [id]);
    const calls = w.fakes.provider.calls.length;
    expect((await w.refunds.process(id)).status).toBe("MANUAL_REVIEW");
    expect(w.fakes.provider.calls.length).toBe(calls);
    expect((await w.raw.query("SELECT 1 FROM journal_entries WHERE idempotency_key = $1", [`refund:${id}`])).rows).toHaveLength(0);
  });

  it("a FAILED refund is not retried before its next attempt time, and is retried after it", async () => {
    const id = await approved();
    w.fakes.provider.script.push({ outcome: "retryable", code: "psp_timeout" });
    expect((await w.refunds.process(id)).status).toBe("FAILED");
    const calls = w.fakes.provider.calls.length;
    expect((await w.refunds.process(id)).status).toBe("FAILED"); // backoff not elapsed
    expect(w.fakes.provider.calls.length).toBe(calls);
    await w.raw.query("UPDATE refunds SET next_attempt_at = '2000-01-01T00:00:00Z' WHERE id = $1", [id]);
    expect((await w.refunds.process(id)).status).toBe("COMPLETED");
    expect(w.fakes.provider.calls.length).toBe(calls + 1);
  });
});

describe("RefundService.createForCancellation", () => {
  const cancelled = async (o: { method?: "card" | "cod" | "bnpl"; price?: bigint; lines?: { price: bigint; discount?: bigint }[]; reason?: string; provider?: string }) => {
    const [storeId] = w.stores;
    const userId = await w.newUser();
    const ord = await w.order({ userId, storeId, lines: o.lines ?? [{ price: o.price ?? 10_000n }], ...(o.method === undefined ? {} : { method: o.method }), ...(o.method === "bnpl" ? { bnplProvider: "valu" } : {}) });
    if (o.provider !== undefined) await w.raw.query("UPDATE payment_intents SET provider = $2 WHERE order_group_id = $1", [ord.groupId, o.provider]);
    if (o.reason === "seller_rejected") await w.raw.query("UPDATE seller_orders SET status = 'REJECTED_BY_SELLER' WHERE id = $1", [ord.sellerOrderId]);
    else await w.raw.query("UPDATE seller_orders SET status = 'CANCELLED', cancelled_at = $2::timestamptz, cancel_reason = 'changed_mind' WHERE id = $1", [ord.sellerOrderId, "2030-01-01T00:00:00Z"]);
    return { userId, ord };
  };

  it("an amount at or above the dual-approval threshold waits as REQUESTED with an approval-required event; a small one is APPROVED", async () => {
    const big = await cancelled({ price: 600_000n });
    const [rb] = await w.refunds.createForCancellation({ userId: big.userId, orderGroupId: big.ord.groupId, reason: "cancellation" });
    expect(rb).toMatchObject({ status: "REQUESTED", replayed: false });
    expect((await w.raw.query("SELECT 1 FROM outbox_events WHERE event_type = 'refund.approval_required' AND aggregate_id = $1", [rb?.id])).rows).toHaveLength(1);
    const small = await cancelled({ price: 10_000n });
    const [rs] = await w.refunds.createForCancellation({ userId: small.userId, orderGroupId: small.ord.groupId, reason: "cancellation" });
    expect(rs).toMatchObject({ status: "APPROVED" });
    expect((await w.raw.query("SELECT 1 FROM outbox_events WHERE event_type = 'refund.approved' AND aggregate_id = $1", [rs?.id])).rows).toHaveLength(1);
    expect((await w.refunds.createForCancellation({ userId: small.userId, orderGroupId: small.ord.groupId, reason: "cancellation" }))[0]).toMatchObject({ id: rs?.id, replayed: true });
  });

  it("a seller rejection refunds only REJECTED_BY_SELLER orders, with the rejection reason; a cancellation reason ignores them", async () => {
    const c = await cancelled({ price: 7_000n, reason: "seller_rejected" });
    expect(await w.refunds.createForCancellation({ userId: c.userId, orderGroupId: c.ord.groupId, reason: "cancellation" })).toEqual([]);
    const [r] = await w.refunds.createForCancellation({ userId: c.userId, orderGroupId: c.ord.groupId, reason: "seller_rejected" });
    expect(r?.amount.amountMinor).toBe(7_000n);
    expect((await w.raw.query<{ reason: string }>("SELECT reason FROM refunds WHERE id = $1", [r?.id])).rows[0]?.reason).toBe("seller_rejected");
  });

  it("routes by tender: card to the PSP, COD with no clearing owner, BNPL to the provider, another PSP to its own clearing", async () => {
    for (const [method, provider] of [["cod", undefined], ["bnpl", undefined], ["card", "kashier"]] as const) {
      const c = await cancelled({ method, ...(provider === undefined ? {} : { provider }), price: 9_000n });
      const out = await w.refunds.createForCancellation({ userId: c.userId, orderGroupId: c.ord.groupId, reason: "cancellation" });
      expect(out, method).toHaveLength(1);
      const row = (await w.raw.query<{ route: string; destinations: { route: string; accountCode: string }[] }>("SELECT route, destinations FROM refunds WHERE id = $1", [out[0]?.id])).rows[0];
      expect(row?.destinations.length, method).toBeGreaterThan(0);
      if (method === "card") expect(row?.destinations.some((d) => d.accountCode.includes("kashier")), "kashier clearing").toBe(true);
      if (method === "bnpl") expect(row?.route).toBe("bnpl_provider");
    }
  });

  it("an unknown order group is not_found", async () => {
    const u = await w.newUser();
    expect(await errCode(w.refunds.createForCancellation({ userId: u, orderGroupId: randomUUID(), reason: "cancellation" }))).toBe("not_found");
  });
});
