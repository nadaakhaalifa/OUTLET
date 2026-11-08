import { randomUUID } from "node:crypto";
import { OrderStateError } from "@outlet/orders";
import { uuidv7 } from "@outlet/ids";
import { Ledger } from "@outlet/ledger";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ACCRUE_CONSUMER, AVAILABILITY_CONSUMER, PayoutsError, listPayoutsForStore } from "../src/index.js";
import { DAY, MONDAY, T0, THRESHOLD, buildWorld, code } from "./fixtures.js";
import type { World } from "./fixtures.js";

let w: World;
beforeAll(async () => { w = await buildWorld(); });
afterAll(async () => { await w.close(); });

const entryByKey = async (key: string): Promise<{ kind: string; postings: [string, bigint][] }> => {
  const e = await w.raw.query<{ id: string; kind: string }>("SELECT id, kind FROM journal_entries WHERE idempotency_key = $1", [key]);
  const row = e.rows[0];
  if (!row) throw new Error(`no entry ${key}`);
  const p = await w.raw.query<{ code: string; amount: string }>(
    "SELECT a.code, p.amount_minor::text AS amount FROM postings p JOIN ledger_accounts a ON a.id = p.account_id WHERE p.entry_id = $1 ORDER BY p.line_no", [row.id]);
  return { kind: row.kind, postings: p.rows.map((r) => [r.code, BigInt(r.amount)]) };
};
const count = async (sql: string, params: unknown[] = []): Promise<number> => Number((await w.raw.query<{ n: string }>(sql, params)).rows[0]?.n ?? "0");
const outboxTypes = async (): Promise<string[]> => (await w.raw.query<{ t: string }>("SELECT event_type AS t FROM outbox_events ORDER BY id")).rows.map((r) => r.t);

/** Funds a closed, eligible accrual for a store directly in the ledger (seller_pending credited by an order, then moved by the mover). */
const fundClosed = async (storeId: string, net: bigint, closedAt: Date, key = randomUUID()): Promise<{ sellerOrderId: string }> => {
  const o = await w.seedOrder({ storeId, netMinor: net });
  await w.post("order_recognised", `order_paid:${key}`, [["psp_clearing", net, "paymob"], ["seller_pending", -net, storeId]]);
  const ev = await w.closeOrder({ sellerOrderId: o.sellerOrderId, storeId, closedAt });
  await w.mover.onSellerOrderClosed(ev);
  return { sellerOrderId: o.sellerOrderId };
};
const ownPayout = async (storeId: string, ids: readonly string[]): Promise<string | undefined> =>
  (await w.raw.query<{ id: string }>("SELECT id FROM payouts WHERE store_id = $1 AND id = ANY($2::uuid[])", [storeId, ids])).rows[0]?.id;
const run = async (storeId: string, net: bigint, now = MONDAY): Promise<{ payoutId: string }> => {
  await fundClosed(storeId, net, T0);
  w.clock.now = now;
  const b = await w.svc.buildCycle("EG", now);
  const id = await ownPayout(storeId, b.payoutIds);
  if (id === undefined) throw new Error(`no payout built for ${storeId}: ${JSON.stringify(b.skipped)}`);
  return { payoutId: id };
};

describe("worked example: weekly payout with negative-balance netting (chart 4.11, store B)", () => {
  it("reproduces the chart entry by entry and settles", async () => {
    const B = await w.newStore("b");
    const A = await w.newStore("a");
    const C = await w.newStore("c");
    // 4.1: one card order for stores A, B, C (396,850), then 4.5: B rejects a 30,000 line before shipping.
    const bOrder = await w.seedOrder({ storeId: B, netMinor: 74_569n });
    await w.post("order_recognised", "order_paid:4.1", [
      ["psp_clearing", 396_850n, "paymob"], ["seller_pending", -207_167n, A], ["seller_pending", -74_569n, B], ["seller_pending", -37_305n, C],
      ["commission_revenue", -57_727n], ["platform_vat_output", -9_556n], ["shipping_revenue", -10_526n],
    ]);
    await w.post("refund_issued", "refund:4.5", [["seller_pending", 24_870n, B], ["commission_revenue", 4_500n], ["platform_vat_output", 630n], ["psp_clearing", -30_000n, "paymob"]]);
    expect(await w.balance("seller_pending", B)).toBe(-49_699n);
    // order_group.paid -> PENDING accrual for B's order
    expect(await w.mover.onOrderGroupPaid({ id: uuidv7(), type: "order_group.paid", aggregateId: bOrder.groupId, marketId: "EG", payload: {} })).toBe("processed");
    expect((await w.raw.query<{ status: string; amount: string }>("SELECT status, amount_minor::text AS amount FROM payout_accruals WHERE seller_order_id = $1", [bOrder.sellerOrderId])).rows[0]).toEqual({ status: "PENDING", amount: "74569" });
    // step 2: post-close defect return on an older order, 20,000 refunded to the card: B owes us 16,580.
    await w.post("refund_issued", "refund:4.11.2", [["seller_available", 16_580n, B], ["commission_revenue", 3_000n], ["platform_vat_output", 420n], ["psp_clearing", -20_000n, "paymob"]]);
    expect(await w.balance("seller_available", B)).toBe(16_580n); // debit-positive: the seller owes us
    // step 3: B's order reaches CLOSED. The refund module states what is left of the pending part (49,699).
    const ev = await w.closeOrder({ sellerOrderId: bOrder.sellerOrderId, storeId: B, closedAt: T0, amount: 49_699n });
    expect(await w.mover.onSellerOrderClosed(ev)).toBe("processed");
    expect(await w.balance("seller_available", B)).toBe(-33_119n); // credit 33,119
    expect(await w.balance("seller_pending", B)).toBe(0n);
    const moved = await entryByKey(`line_closed:${bOrder.sellerOrderId}`);
    expect(moved.kind).toBe("line_closed");
    expect(moved.postings).toEqual([["seller_pending:EG:EGP:" + B, 49_699n], ["seller_available:EG:EGP:" + B, -49_699n]]);

    // step 4: Monday payout run
    w.clock.now = MONDAY;
    const built = await w.svc.buildCycle("EG", MONDAY);
    expect(built.cycle).toEqual({ start: "2029-12-31", end: "2030-01-06" });
    const skipA = built.skipped;
    expect(skipA).toEqual([]); // A and C have no AVAILABLE accrual, so they are not candidates
    const payoutId = built.payoutIds[0] ?? "";
    expect(built.payoutIds).toHaveLength(1);
    const p = await w.svc.get("EG", payoutId);
    expect([p.status, p.grossMinor, p.adjustmentsMinor, p.netMinor, p.sendAttempt]).toEqual(["SCHEDULED", 49_699n, -16_580n, 33_119n, 1]);
    const lines = await w.raw.query<{ kind: string; amount: string }>("SELECT kind, amount_minor::text AS amount FROM payout_lines WHERE payout_id = $1 ORDER BY kind", [payoutId]);
    expect(lines.rows).toEqual([{ kind: "adjustment", amount: "-16580" }, { kind: "order", amount: "49699" }]);
    const batch = (await w.raw.query<{ n: number; total: string; status: string }>("SELECT payout_count AS n, total_net_minor::text AS total, status FROM payout_batches")).rows[0];
    expect(batch).toEqual({ n: 1, total: "33119", status: "SCHEDULED" });

    const fin = await w.finance();
    expect(await w.svc.approve(fin, payoutId)).toEqual({ status: "approved" }); // below the threshold: no second key
    expect(await count("SELECT count(*)::text AS n FROM approval_requests")).toBe(0);
    expect(await w.svc.send("EG", payoutId)).toEqual({ status: "SENT", providerRef: `fb-${payoutId}` });
    const sent = await entryByKey(`payout_sent:${payoutId}:1`);
    expect(sent.kind).toBe("payout_sent");
    expect(sent.postings).toEqual([["seller_available:EG:EGP:" + B, 33_119n], ["payouts_in_transit:EG:EGP", -33_119n]]);
    expect(await w.balance("seller_available", B)).toBe(0n);
    await w.svc.settleByProviderRef("EG", "fakebank", `fb-${payoutId}`, MONDAY);
    const settled = await entryByKey(`payout_settled:${payoutId}`);
    expect(settled.kind).toBe("payout_settled");
    expect(settled.postings).toEqual([["payouts_in_transit:EG:EGP", 33_119n], ["bank_collections:EG:EGP:main", -33_119n]]);
    expect(await w.balance("payouts_in_transit")).toBe(0n);
    expect((await w.svc.get("EG", payoutId)).status).toBe("SETTLED");
    expect((await w.raw.query<{ status: string }>("SELECT status FROM payout_accruals WHERE seller_order_id = $1", [bOrder.sellerOrderId])).rows[0]?.status).toBe("PAID");
    expect((await w.raw.query<{ status: string }>("SELECT status FROM payout_batches")).rows[0]?.status).toBe("COMPLETED");
    expect(await outboxTypes()).toEqual(expect.arrayContaining(["payout.scheduled", "payout.sent", "payout.settled", "journal_entry.posted"]));
    expect(w.audits.map((a) => a.action)).toEqual(expect.arrayContaining(["payout.scheduled", "payout.approved", "payout.sent", "payout.settled"]));
    const integrity = await w.integrity.run("EG", MONDAY);
    expect(integrity.ok).toBe(true);
  });
});

describe("availability mover (inbox consumers)", () => {
  it("is idempotent per message id and never moves twice", async () => {
    const s = await w.newStore();
    const o = await w.seedOrder({ storeId: s, netMinor: 5_000n });
    await w.post("order_recognised", `op:${o.sellerOrderId}`, [["psp_clearing", 5_000n, "paymob"], ["seller_pending", -5_000n, s]]);
    const ev = await w.closeOrder({ sellerOrderId: o.sellerOrderId, storeId: s, closedAt: T0 });
    expect(await w.mover.onSellerOrderClosed(ev)).toBe("processed");
    expect(await w.mover.onSellerOrderClosed(ev)).toBe("duplicate");
    // a different message for the same order (relay replay with a new id) is absorbed by the ledger key
    expect(await w.mover.onSellerOrderClosed({ ...ev, id: uuidv7() })).toBe("processed");
    expect(await w.balance("seller_available", s)).toBe(-5_000n);
    expect(await count("SELECT count(*)::text AS n FROM journal_entries WHERE idempotency_key = $1", [`line_closed:${o.sellerOrderId}`])).toBe(1);
    expect(await count("SELECT count(*)::text AS n FROM payout_accruals WHERE seller_order_id = $1", [o.sellerOrderId])).toBe(1);
    expect(await count("SELECT count(*)::text AS n FROM inbox_processed WHERE consumer = $1", [AVAILABILITY_CONSUMER])).toBeGreaterThan(0);
  });

  it("refuses to move money that is not pending (I11) and orders that are not CLOSED", async () => {
    const s = await w.newStore();
    const o = await w.seedOrder({ storeId: s, netMinor: 5_000n });
    await w.post("order_recognised", `op:${o.sellerOrderId}`, [["psp_clearing", 1_000n, "paymob"], ["seller_pending", -1_000n, s]]);
    const ev = await w.closeOrder({ sellerOrderId: o.sellerOrderId, storeId: s, closedAt: T0 });
    expect(await code(w.mover.onSellerOrderClosed(ev))).toBe("INSUFFICIENT_PENDING");
    expect(await count("SELECT count(*)::text AS n FROM inbox_processed WHERE message_id = $1", [ev.id])).toBe(0); // rolled back: redeliverable
    const open = await w.seedOrder({ storeId: s, netMinor: 100n, status: "DELIVERED", deliveredAt: T0 });
    expect(await code(w.mover.onSellerOrderClosed({ id: uuidv7(), type: "seller_order.closed", aggregateId: open.sellerOrderId, marketId: "EG", payload: {} }))).toBe("INVALID_STATE");
    expect(await code(w.mover.onSellerOrderClosed({ id: uuidv7(), type: "seller_order.closed", aggregateId: randomUUID(), marketId: "EG", payload: {} }))).toBe("NOT_FOUND");
    expect(await code(w.mover.onSellerOrderClosed({ ...ev, id: uuidv7(), payload: { amount_minor: "-5" } }))).toBe("INVALID_INPUT");
  });

  it("ignores psp_split orders (the PSP pays the seller) and zero amounts, and rejects a foreign currency", async () => {
    const s = await w.newStore();
    const split = await w.seedOrder({ storeId: s, netMinor: 5_000n, fundsFlow: "psp_split" });
    const ev = await w.closeOrder({ sellerOrderId: split.sellerOrderId, storeId: s, closedAt: T0 });
    expect(await w.mover.onSellerOrderClosed(ev)).toBe("processed");
    expect(await count("SELECT count(*)::text AS n FROM payout_accruals WHERE seller_order_id = $1", [split.sellerOrderId])).toBe(0);
    expect(await w.mover.onOrderGroupPaid({ id: uuidv7(), type: "order_group.paid", aggregateId: split.groupId, marketId: "EG", payload: {} })).toBe("processed");
    expect(await count("SELECT count(*)::text AS n FROM payout_accruals WHERE seller_order_id = $1", [split.sellerOrderId])).toBe(0);
    const zero = await w.seedOrder({ storeId: s, netMinor: 5_000n });
    const zev = await w.closeOrder({ sellerOrderId: zero.sellerOrderId, storeId: s, closedAt: T0, amount: 0n });
    expect(await w.mover.onSellerOrderClosed(zev)).toBe("processed");
    expect(await count("SELECT count(*)::text AS n FROM payout_accruals WHERE seller_order_id = $1", [zero.sellerOrderId])).toBe(0);
    const usd = await w.seedOrder({ storeId: s, netMinor: 5_000n });
    await w.raw.query("UPDATE seller_orders SET currency = 'USD', status = 'CLOSED', closed_at = $2 WHERE id = $1", [usd.sellerOrderId, T0.toISOString()]);
    expect(await code(w.mover.onSellerOrderClosed({ id: uuidv7(), type: "seller_order.closed", aggregateId: usd.sellerOrderId, marketId: "EG", payload: {} }))).toBe("CURRENCY_MISMATCH");
    expect(ACCRUE_CONSUMER).not.toBe(AVAILABILITY_CONSUMER);
  });
});

describe("eligibility at the cycle run", () => {
  it("pays exactly at closed_at + 3 days and not one millisecond earlier", async () => {
    const s = await w.newStore();
    await fundClosed(s, 10_000n, T0);
    const eligibleAt = new Date(T0.getTime() + 3 * DAY);
    const before = await w.svc.buildCycle("EG", new Date(eligibleAt.getTime() - 1));
    expect(before.payoutIds).toEqual([]);
    expect(before.skipped.find((x) => x.storeId === s)?.reason).toBe("nothing_eligible");
    const at = await w.svc.buildCycle("EG", eligibleAt);
    expect(await ownPayout(s, at.payoutIds)).toBeDefined();
  });

  it("an open dispute hold blocks the whole store; a hold on one order blocks only that order; release lets it through", async () => {
    const s = await w.newStore();
    const o1 = await fundClosed(s, 10_000n, T0);
    const o2 = await fundClosed(s, 7_000n, T0);
    const hold = uuidv7();
    await w.raw.query("INSERT INTO payout_holds (id, store_id, market_id, reason, starts_at) VALUES ($1,$2,'EG','dispute',$3)", [hold, s, T0.toISOString()]);
    w.clock.now = MONDAY;
    expect((await w.svc.buildCycle("EG", MONDAY)).skipped.find((x) => x.storeId === s)?.reason).toBe("nothing_eligible");
    await w.raw.query("UPDATE payout_holds SET released_at = $2 WHERE id = $1", [hold, MONDAY.toISOString()]);
    await w.raw.query("INSERT INTO payout_holds (id, store_id, market_id, reason, seller_order_id, starts_at) VALUES ($1,$2,'EG','dispute',$3,$4)", [uuidv7(), s, o1.sellerOrderId, T0.toISOString()]);
    const built = await w.svc.buildCycle("EG", MONDAY);
    const id = (await ownPayout(s, built.payoutIds)) ?? "";
    const p = await w.svc.get("EG", id);
    expect([p.grossMinor, p.netMinor]).toEqual([7_000n, 7_000n]); // o1 (10,000) stays closed-but-held: it is not paid and not netted
    const accr = await w.raw.query<{ status: string; seller_order_id: string }>("SELECT status, seller_order_id FROM payout_accruals WHERE store_id = $1 ORDER BY status", [s]);
    expect(accr.rows.find((r) => r.seller_order_id === o1.sellerOrderId)?.status).toBe("AVAILABLE");
    expect(accr.rows.find((r) => r.seller_order_id === o2.sellerOrderId)?.status).toBe("SCHEDULED");
  });

  it("a debt larger than the eligible money pays nothing; the next cycle recovers it (carry forward)", async () => {
    const s = await w.newStore();
    await fundClosed(s, 5_000n, T0);
    await w.post("refund_issued", `debt:${s}`, [["seller_available", 8_000n, s], ["psp_clearing", -8_000n, "paymob"]]); // balance: 5,000 - 8,000 = -3,000
    w.clock.now = MONDAY;
    expect((await w.svc.buildCycle("EG", MONDAY)).skipped.find((x) => x.storeId === s)?.reason).toBe("no_balance");
    const nextMonday = new Date(MONDAY.getTime() + 7 * DAY);
    await fundClosed(s, 20_000n, new Date(MONDAY.getTime() - DAY));
    w.clock.now = nextMonday;
    const built = await w.svc.buildCycle("EG", nextMonday);
    const p = await w.svc.get("EG", (await ownPayout(s, built.payoutIds)) ?? "");
    expect([p.grossMinor, p.adjustmentsMinor, p.netMinor]).toEqual([25_000n, -8_000n, 17_000n]); // 5,000 + 20,000 gross, the 8,000 refund netted
  });
});

describe("cycle scheduling", () => {
  it("is idempotent per store and week, and an open payout blocks the next one", async () => {
    const s = await w.newStore();
    const { payoutId } = await run(s, 12_000n);
    const again = await w.svc.buildCycle("EG", new Date(MONDAY.getTime() + DAY));
    expect(again.payoutIds).toEqual([]);
    expect(again.skipped.find((x) => x.storeId === s)).toBeUndefined(); // no AVAILABLE accrual left: not even a candidate
    expect(await count("SELECT count(*)::text AS n FROM payouts WHERE store_id = $1", [s])).toBe(1);
    await fundClosed(s, 3_000n, new Date(MONDAY.getTime() - DAY));
    const sameWeek = await w.svc.buildCycle("EG", MONDAY);
    expect(sameWeek.skipped.find((x) => x.storeId === s)?.reason).toBe("already_scheduled");
    const nextWeek = await w.svc.buildCycle("EG", new Date(MONDAY.getTime() + 8 * DAY));
    expect(nextWeek.skipped.find((x) => x.storeId === s)?.reason).toBe("open_payout"); // the first payout is still SCHEDULED
    await w.svc.cancel("EG", payoutId, "test");
    const after = await w.svc.buildCycle("EG", new Date(MONDAY.getTime() + 15 * DAY));
    expect(await ownPayout(s, after.payoutIds)).toBeDefined();
  });

  it("parks the payout ON_HOLD when the IBAN holder is not the seller, and skips a store with no verified account", async () => {
    const s = await w.newStore();
    w.destinations.set(s, { instrumentId: randomUUID(), ibanLast4: "9999", accountHolderName: "Someone Else", legalName: "Company" });
    const { payoutId } = await run(s, 9_000n);
    const p = await w.svc.get("EG", payoutId);
    expect([p.status, p.holdReason]).toEqual(["ON_HOLD", "iban_name_mismatch"]);
    const s2 = await w.newStore();
    w.destinations.set(s2, null);
    await fundClosed(s2, 4_000n, T0);
    const b = await w.svc.buildCycle("EG", new Date(MONDAY.getTime() + 30 * DAY));
    expect(b.skipped.find((x) => x.storeId === s2)?.reason).toBe("no_verified_instrument");
  });

  it("skips accruals in a foreign currency", async () => {
    const s = await w.newStore();
    await fundClosed(s, 4_000n, T0);
    await w.raw.query("UPDATE payout_accruals SET currency = 'USD' WHERE store_id = $1", [s]);
    const b = await w.svc.buildCycle("EG", new Date(MONDAY.getTime() + 60 * DAY));
    expect(b.skipped.find((x) => x.storeId === s)?.reason).toBe("currency_mismatch");
  });
});

describe("dual approval (payout.approve via admin-access)", () => {
  it("below the threshold the finance admin approves alone; at the threshold a second key is required", async () => {
    const small = await w.newStore();
    const { payoutId: smallId } = await run(small, THRESHOLD - 1n, new Date(MONDAY.getTime() + 90 * DAY));
    const fin = await w.finance();
    expect(await w.svc.approve(fin, smallId)).toEqual({ status: "approved" });

    const big = await w.newStore();
    const { payoutId } = await run(big, THRESHOLD, new Date(MONDAY.getTime() + 90 * DAY));
    const requester = await w.finance();
    const first = await w.svc.approve(requester, payoutId);
    expect(first.status).toBe("approval_required");
    const requestId = first.status === "approval_required" ? first.requestId : "";
    expect(await w.svc.approve(requester, payoutId)).toEqual({ status: "approval_required", requestId }); // no duplicate request
    expect((await w.svc.get("EG", payoutId)).status).toBe("SCHEDULED");
    expect(await code(w.svc.send("EG", payoutId))).toBe("INVALID_STATE"); // cannot bypass the approval
    expect(await code(w.svc.completeApproval(requester, payoutId))).toBe("APPROVAL_NOT_APPROVED");
    await w.admin.approve(await w.finance(), requestId);
    await w.admin.approve(await w.finance(), requestId);
    expect(await w.svc.completeApproval(requester, payoutId)).toEqual({ status: "approved" });
    expect(await w.svc.completeApproval(requester, payoutId)).toEqual({ status: "approved" }); // replay
    expect((await w.svc.get("EG", payoutId)).status).toBe("APPROVED");
    expect(await w.svc.send("EG", payoutId)).toMatchObject({ status: "SENT" });
  });

  it("a rejected request can be renewed; non-finance principals and non-admins are refused", async () => {
    const s = await w.newStore();
    const { payoutId } = await run(s, THRESHOLD + 5n, new Date(MONDAY.getTime() + 120 * DAY));
    const requester = await w.finance();
    const first = await w.svc.approve(requester, payoutId);
    const id1 = first.status === "approval_required" ? first.requestId : "";
    await w.admin.reject(await w.finance(), id1, "wrong bank");
    const second = await w.svc.approve(requester, payoutId, { renew: true });
    expect(second.status === "approval_required" && second.requestId !== id1).toBe(true);
    const support = await w.admin.buildPrincipal("EG", uuidv7());
    expect(await code(w.svc.approve(support, payoutId))).toBe("FORBIDDEN");
    expect(await code(w.svc.approve({ kind: "shopper", userId: uuidv7(), marketId: "EG", roles: [], scopes: [] }, payoutId))).toBe("INVALID_INPUT");
    expect(await code(w.svc.completeApproval(requester, randomUUID()))).toBe("NOT_FOUND");
    const noRequest = await w.newStore();
    const { payoutId: other } = await run(noRequest, 1_000n, new Date(MONDAY.getTime() + 150 * DAY));
    expect(await code(w.svc.completeApproval(requester, other))).toBe("APPROVAL_NOT_READY");
    expect(await code(w.svc.approve(requester, randomUUID()))).toBe("NOT_FOUND");
    expect(w.audits.some((a) => a.action === "payout.approval_requested")).toBe(true);
  });

  it("an approval filed for one payout cannot release another", async () => {
    const s1 = await w.newStore();
    const s2 = await w.newStore();
    const { payoutId: p1 } = await run(s1, THRESHOLD, new Date(MONDAY.getTime() + 180 * DAY));
    await fundClosed(s2, THRESHOLD, T0);
    const b = await w.svc.buildCycle("EG", new Date(MONDAY.getTime() + 180 * DAY));
    const p2 = (await ownPayout(s2, b.payoutIds)) ?? "";
    const requester = await w.finance();
    const r1 = await w.svc.approve(requester, p1);
    await w.admin.approve(await w.finance(), r1.status === "approval_required" ? r1.requestId : "");
    await w.admin.approve(await w.finance(), r1.status === "approval_required" ? r1.requestId : "");
    // forge: point payout 2 at payout 1's (approved) request
    await w.raw.query("UPDATE payouts SET approval_request_id = $2 WHERE id = $1", [p2, r1.status === "approval_required" ? r1.requestId : ""]);
    expect(await code(w.svc.completeApproval(requester, p2))).toBe("APPROVAL_NOT_READY");
    expect((await w.svc.get("EG", p2)).status).toBe("SCHEDULED");
  });
});

describe("send, replay, failure", () => {
  it("send is idempotent: replays do not move money twice; a timed-out rail is resumed with the same key", async () => {
    const s = await w.newStore();
    const { payoutId } = await run(s, 15_000n, new Date(MONDAY.getTime() + 210 * DAY));
    await w.svc.approve(await w.finance(), payoutId);
    const transfers = w.rail.transfers;
    const transitBefore = await w.balance("payouts_in_transit");
    w.rail.throwOnce = true;
    await expect(w.svc.send("EG", payoutId)).rejects.toThrow("rail timeout");
    expect((await w.svc.get("EG", payoutId)).status).toBe("SENT"); // outcome unknown: stays SENT, money already out of seller_available
    expect(await w.balance("seller_available", s)).toBe(0n);
    expect(await w.svc.send("EG", payoutId)).toMatchObject({ status: "SENT", providerRef: `fb-${payoutId}` });
    expect(await w.svc.send("EG", payoutId)).toMatchObject({ status: "SENT" }); // plain replay
    expect(w.rail.transfers).toBe(transfers + 1);
    expect(w.rail.calls.filter((c) => c.payoutId === payoutId).map((c) => c.idempotencyKey)).toEqual([`payout:${payoutId}:1`, `payout:${payoutId}:1`]);
    expect(await count("SELECT count(*)::text AS n FROM journal_entries WHERE idempotency_key = $1", [`payout_sent:${payoutId}:1`])).toBe(1);
    expect(await w.balance("payouts_in_transit")).toBe(transitBefore - 15_000n);
    await w.svc.settle("EG", payoutId);
    await w.svc.settle("EG", payoutId); // replay
    expect(await count("SELECT count(*)::text AS n FROM journal_entries WHERE idempotency_key = $1", [`payout_settled:${payoutId}`])).toBe(1);
    expect(await code(w.svc.send("EG", payoutId))).toBe("INVALID_STATE");
    await expect(w.svc.settleByProviderRef("EG", "fakebank", "unknown")).rejects.toBeInstanceOf(PayoutsError);
  });

  it("a rail rejection reverses the ledger entry and parks the payout; after release and re-approval it is a NEW transfer", async () => {
    const s = await w.newStore();
    const { payoutId } = await run(s, 22_000n, new Date(MONDAY.getTime() + 240 * DAY));
    const fin = await w.finance();
    await w.svc.approve(fin, payoutId);
    const transitBefore = await w.balance("payouts_in_transit");
    w.rail.rejectWith = "invalid_account";
    expect(await w.svc.send("EG", payoutId)).toEqual({ status: "FAILED", code: "invalid_account" });
    w.rail.rejectWith = null;
    const p = await w.svc.get("EG", payoutId);
    expect([p.status, p.holdReason, p.failureCode, p.sendAttempt]).toEqual(["ON_HOLD", "rail_failed:invalid_account", "invalid_account", 2]);
    expect(await w.balance("seller_available", s)).toBe(-22_000n); // restored by the reversal
    expect(await w.balance("payouts_in_transit")).toBe(transitBefore);
    const rev = await entryByKey(`payout_failed:${payoutId}:1`);
    expect(rev.kind).toBe("reversal");
    expect(rev.postings).toEqual([["seller_available:EG:EGP:" + s, -22_000n], ["payouts_in_transit:EG:EGP", 22_000n]]);
    expect((await w.raw.query<{ status: string }>("SELECT status FROM payout_accruals WHERE payout_id = $1", [payoutId])).rows[0]?.status).toBe("SCHEDULED");
    await w.svc.fail("EG", payoutId, "invalid_account", { providerRef: null, sendAttempt: 1 }); // replay of the same attempt is a no-op
    expect(await count("SELECT count(*)::text AS n FROM journal_entries WHERE kind = 'reversal' AND idempotency_key = $1", [`payout_failed:${payoutId}:1`])).toBe(1);
    expect(await code(w.svc.send("EG", payoutId))).toBe("INVALID_STATE");
    await w.svc.release("EG", payoutId);
    await w.svc.approve(fin, payoutId);
    expect(await w.svc.send("EG", payoutId)).toMatchObject({ status: "SENT" });
    expect(w.rail.calls.at(-1)?.idempotencyKey).toBe(`payout:${payoutId}:2`);
    expect(await w.balance("payouts_in_transit")).toBe(transitBefore - 22_000n);
    expect(await w.balance("seller_available", s)).toBe(0n);
    expect((await w.integrity.run("EG", MONDAY)).ok).toBe(true);
  });

  it("holds instead of paying when the balance fell below the payout after scheduling (I12), and when the destination went bad", async () => {
    const s = await w.newStore();
    const { payoutId } = await run(s, 30_000n, new Date(MONDAY.getTime() + 270 * DAY));
    await w.svc.approve(await w.finance(), payoutId);
    await w.post("refund_issued", `late-clawback:${s}`, [["seller_available", 5_000n, s], ["psp_clearing", -5_000n, "paymob"]]);
    expect(await w.svc.send("EG", payoutId)).toEqual({ status: "ON_HOLD", reason: "insufficient_balance" });
    expect(await w.balance("seller_available", s)).toBe(-25_000n); // nothing was paid
    expect(w.rail.calls.some((c) => c.payoutId === payoutId)).toBe(false);
    await w.svc.release("EG", payoutId);
    await w.svc.cancel("EG", payoutId, "rebuild next cycle");
    const s2 = await w.newStore();
    const { payoutId: p2 } = await run(s2, 8_000n, new Date(MONDAY.getTime() + 300 * DAY));
    await w.svc.approve(await w.finance(), p2);
    w.destinations.set(s2, null);
    expect(await w.svc.send("EG", p2)).toEqual({ status: "ON_HOLD", reason: "no_verified_instrument" });
    await expect(w.svc.hold("EG", p2, "manual")).rejects.toBeInstanceOf(OrderStateError); // already ON_HOLD
  });

  it("hold, release and cancel follow the machine and free the accruals on cancel", async () => {
    const s = await w.newStore();
    const { payoutId } = await run(s, 6_000n, new Date(MONDAY.getTime() + 330 * DAY));
    await w.svc.hold("EG", payoutId, "risk review");
    expect((await w.svc.get("EG", payoutId)).holdReason).toBe("risk review");
    expect(await code(w.svc.send("EG", payoutId))).toBe("INVALID_STATE");
    await w.svc.release("EG", payoutId);
    expect((await w.svc.get("EG", payoutId)).status).toBe("SCHEDULED");
    await w.svc.cancel("EG", payoutId, "seller closed");
    expect((await w.svc.get("EG", payoutId)).status).toBe("CANCELLED");
    expect((await w.raw.query<{ status: string; payout_id: string | null }>("SELECT status, payout_id FROM payout_accruals WHERE store_id = $1", [s])).rows[0]).toEqual({ status: "AVAILABLE", payout_id: null });
    await expect(w.svc.cancel("EG", payoutId, "again")).rejects.toBeInstanceOf(OrderStateError);
    await expect(w.svc.fail("EG", payoutId, "x", { providerRef: null, sendAttempt: 1 })).rejects.toBeInstanceOf(PayoutsError);
  });
});

describe("tenant isolation and grants", () => {
  it("a seller sees only their own payouts, lines and accruals; the app role cannot write money tables or read holds and finance files", async () => {
    const a = await w.newStore();
    const b = await w.newStore();
    const { payoutId: pa } = await run(a, 11_000n, new Date(MONDAY.getTime() + 360 * DAY));
    await fundClosed(b, 13_000n, T0);
    const bBuilt = await w.svc.buildCycle("EG", new Date(MONDAY.getTime() + 361 * DAY));
    const pb = (await ownPayout(b, bBuilt.payoutIds)) ?? "";
    const mine = await listPayoutsForStore(w.app, { marketId: "EG", storeId: a });
    expect(mine.map((p) => p.id)).toEqual([pa]);
    expect(mine[0]).toMatchObject({ netMinor: 11_000n, status: "SCHEDULED", currency: "EGP" });
    expect(Object.keys(mine[0] ?? {})).not.toContain("approvalRequestId");
    expect((await listPayoutsForStore(w.app, { marketId: "EG", storeId: b })).map((p) => p.id)).toEqual([pb]);
    expect(await listPayoutsForStore(w.app, { marketId: "EG", storeId: randomUUID() })).toEqual([]);
    expect(await listPayoutsForStore(w.app, { marketId: "EG", storeId: a, limit: 0 })).toHaveLength(1);

    const asA = async <T>(fn: (tx: import("@outlet/db").Queryable) => Promise<T>): Promise<T> =>
      (await import("@outlet/db")).withDbContext(w.app, { kind: "store", marketId: "EG", storeId: a }, fn);
    expect((await asA((tx) => tx.query("SELECT id FROM payouts WHERE id = $1", [pb]))).rows).toEqual([]); // B's payout: invisible, not forbidden
    expect((await asA((tx) => tx.query("SELECT id FROM payout_lines WHERE payout_id = $1", [pb]))).rows).toEqual([]);
    expect((await asA((tx) => tx.query("SELECT id FROM payout_accruals WHERE store_id = $1", [b]))).rows).toEqual([]);
    expect((await asA((tx) => tx.query("SELECT id FROM payout_lines WHERE payout_id = $1", [pa]))).rows.length).toBeGreaterThan(0);
    await expect(asA((tx) => tx.query("UPDATE payouts SET net_minor = 1 WHERE id = $1", [pa]))).rejects.toThrow(/permission denied/);
    await expect(asA((tx) => tx.query("DELETE FROM payouts WHERE id = $1", [pa]))).rejects.toThrow(/permission denied/);
    await expect(asA((tx) => tx.query("INSERT INTO payout_lines (id, payout_id, store_id, market_id, kind, amount_minor, currency) VALUES ($1,$2,$3,'EG','adjustment',5,'EGP')", [uuidv7(), pa, a]))).rejects.toThrow(/permission denied/);
    for (const t of ["payout_holds", "payout_batches", "psp_settlement_files", "psp_settlement_lines", "cod_remittances", "cod_remittance_lines", "reconciliation_runs", "reconciliation_matches", "reconciliation_exceptions"]) {
      await expect(asA((tx) => tx.query(`SELECT 1 FROM ${t}`))).rejects.toThrow(/permission denied/);
    }
  });

  it("the worker is limited to its jobs: other jobs see no payouts and cannot write them; money columns are immutable", async () => {
    const { withDbContext } = await import("@outlet/db");
    const s = await w.newStore();
    const { payoutId } = await run(s, 14_000n, new Date(MONDAY.getTime() + 400 * DAY));
    const as = <T>(job: "finance.refunds" | "finance.reconcile" | "finance.payouts", fn: (tx: import("@outlet/db").Queryable) => Promise<T>): Promise<T> =>
      withDbContext(w.worker, { kind: "worker", marketId: "EG", job }, fn);
    expect((await as("finance.refunds", (tx) => tx.query("SELECT id FROM payouts WHERE id = $1", [payoutId]))).rows).toEqual([]);
    expect((await as("finance.reconcile", (tx) => tx.query("SELECT id FROM payouts WHERE id = $1", [payoutId]))).rows).toHaveLength(1);
    expect((await as("finance.reconcile", (tx) => tx.query("UPDATE payouts SET status = 'SENT' WHERE id = $1 RETURNING id", [payoutId]))).rows).toEqual([]); // SELECT-only policy
    expect((await withDbContext(w.worker, { kind: "worker", marketId: "XX", job: "finance.payouts" }, (tx) => tx.query("SELECT id FROM payouts WHERE id = $1", [payoutId]))).rows).toEqual([]);
    await expect(as("finance.payouts", (tx) => tx.query("UPDATE payouts SET net_minor = 1, gross_minor = 1, adjustments_minor = 0 WHERE id = $1", [payoutId]))).rejects.toThrow(/permission denied/);
    await expect(as("finance.payouts", (tx) => tx.query("DELETE FROM payouts WHERE id = $1", [payoutId]))).rejects.toThrow(/permission denied/);
    await expect(as("finance.payouts", (tx) => tx.query("UPDATE journal_entries SET kind = 'reversal' WHERE true"))).rejects.toThrow();
  });
});

describe("ledger is untouched by reads and stays balanced", () => {
  it("trial balance is zero and the chain verifies after everything above", async () => {
    const report = await w.integrity.run("EG", new Date(MONDAY.getTime() + 500 * DAY));
    expect(report.checks.find((c) => c.name === "trial_balance_zero")?.ok).toBe(true);
    expect(report.checks.find((c) => c.name === "hash_chain")?.ok).toBe(true);
    expect((await w.raw.transaction((tx) => Ledger.trialBalance(tx, "EG", "EGP"))).amountMinor).toBe(0n);
  });
});
