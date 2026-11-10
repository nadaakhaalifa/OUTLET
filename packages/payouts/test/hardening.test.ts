import { randomUUID } from "node:crypto";
import { withDbContext } from "@outlet/db";
import { uuidv7 } from "@outlet/ids";
import { Ledger, accountCode } from "@outlet/ledger";
import { money } from "@outlet/money";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AVAILABILITY_CONSUMER, DISPUTE_OPENED_EVENT, DISPUTE_RESOLVED_EVENT, DisputeEventPayload, PayoutService, PayoutsError, SellerOrderClosedPayload } from "../src/index.js";
import type { ConsumedEvent } from "../src/index.js";
import { DAY, MONDAY, T0, THRESHOLD, buildWorld, code, fundClosed, ownPayout, scheduledPayout } from "./fixtures.js";
import type { World } from "./fixtures.js";

let w: World;
beforeAll(async () => { w = await buildWorld(); });
afterAll(async () => { await w.close(); });

const at = (days: number): Date => new Date(MONDAY.getTime() + days * DAY);
const count = async (sql: string, params: unknown[] = []): Promise<number> => Number((await w.raw.query<{ n: string }>(sql, params)).rows[0]?.n ?? "0");

describe("B1: a failure names the attempt it applies to", () => {
  it("refuses a stale bank return for attempt 1 once attempt 2 is out, and applies the matching one", async () => {
    const s = await w.newStore();
    const id = await scheduledPayout(w, s, 20_000n, at(400));
    const fin = await w.finance();
    await w.svc.approve(fin, id);
    const first = await w.svc.send("EG", id);
    expect(first).toMatchObject({ status: "SENT" });
    const ref1 = first.status === "SENT" ? first.providerRef : "";
    await w.svc.fail("EG", id, "bank_return", { providerRef: ref1, sendAttempt: 1 });
    let p = await w.svc.get("EG", id);
    expect([p.status, p.sendAttempt]).toEqual(["ON_HOLD", 2]);
    await w.svc.fail("EG", id, "bank_return", { providerRef: ref1, sendAttempt: 1 }); // replay of the applied failure: no-op
    expect(await count("SELECT count(*)::text AS n FROM journal_entries WHERE kind = 'reversal' AND idempotency_key LIKE $1", [`payout_failed:${id}:%`])).toBe(1);

    await w.svc.release("EG", id);
    await w.svc.approve(fin, id);
    expect(await w.svc.send("EG", id)).toMatchObject({ status: "SENT" }); // attempt 2
    const before = await w.balance("payouts_in_transit");
    expect(await code(w.svc.fail("EG", id, "bank_return", { providerRef: ref1, sendAttempt: 1 }))).toBe("STALE_ATTEMPT");
    expect(await code(w.svc.fail("EG", id, "bank_return", { providerRef: "other-ref", sendAttempt: 2 }))).toBe("STALE_ATTEMPT");
    p = await w.svc.get("EG", id);
    expect(p.status).toBe("SENT");
    expect(await w.balance("payouts_in_transit")).toBe(before); // nothing was reversed

    await w.svc.fail("EG", id, "bank_return", { providerRef: p.providerRef, sendAttempt: 2 });
    p = await w.svc.get("EG", id);
    expect([p.status, p.sendAttempt]).toEqual(["ON_HOLD", 3]);
    expect(await count("SELECT count(*)::text AS n FROM journal_entries WHERE kind = 'reversal' AND idempotency_key LIKE $1", [`payout_failed:${id}:%`])).toBe(2);
    expect((await w.integrity.run("EG", MONDAY)).ok).toBe(true);
  });

  it("a payout that was never sent cannot be failed, even with the matching attempt", async () => {
    const s = await w.newStore();
    const id = await scheduledPayout(w, s, 9_000n, at(430));
    await w.svc.approve(await w.finance(), id);
    await w.raw.query("UPDATE payouts SET status = 'SENT' WHERE id = $1", [id]); // forged state: SENT without a ledger entry
    expect(await code(w.svc.fail("EG", id, "x", { providerRef: null, sendAttempt: 1 }))).toBe("INVALID_STATE");
  });

  it("an ON_HOLD payout that never failed is refused (stale), not silently accepted", async () => {
    const s = await w.newStore();
    const id = await scheduledPayout(w, s, 9_500n, at(440));
    await w.svc.hold("EG", id, "manual");
    expect(await code(w.svc.fail("EG", id, "x", { providerRef: null, sendAttempt: 0 }))).toBe("STALE_ATTEMPT");
  });
});

describe("send and settle: remaining branches", () => {
  it("a destination that disappears while a timed-out send is retried stops the retry", async () => {
    const s = await w.newStore();
    const id = await scheduledPayout(w, s, 12_000n, at(460));
    await w.svc.approve(await w.finance(), id);
    w.rail.throwOnce = true;
    await expect(w.svc.send("EG", id)).rejects.toThrow("rail timeout");
    expect((await w.svc.get("EG", id)).providerRef).toBeNull(); // outcome unknown: the previous attempt's reference is not carried over
    w.destinations.set(s, null);
    expect(await code(w.svc.send("EG", id))).toBe("INVALID_STATE");
  });

  it("settleByProviderRef reports NOT_FOUND for an unknown reference", async () => {
    expect(await code(w.svc.settleByProviderRef("EG", "fakebank", "nope"))).toBe("NOT_FOUND");
  });

  it("move() reports a concurrent change when the version moved on", async () => {
    const s = await w.newStore();
    const id = await scheduledPayout(w, s, 7_000n, at(480));
    const stale = await w.svc.get("EG", id);
    await w.svc.hold("EG", id, "first"); // bumps the version
    const move = (w.svc as unknown as { move: (tx: unknown, p: typeof stale, e: string) => Promise<unknown> }).move.bind(w.svc);
    const out = await withDbContext(w.worker, { kind: "worker", marketId: "EG", job: "finance.payouts" }, async (tx) => {
      try { await move(tx, stale, "hold"); return "NO_ERROR"; } catch (e) { return e instanceof PayoutsError ? e.code : "OTHER"; }
    });
    expect(out).toBe("INVALID_STATE");
  });
});

describe("B3: completeApproval after the approval was already consumed", () => {
  const filed = async (net: bigint, day: number): Promise<{ id: string; requestId: string; requester: Awaited<ReturnType<World["finance"]>> }> => {
    const s = await w.newStore();
    const id = await scheduledPayout(w, s, net, at(day));
    const requester = await w.finance();
    const r = await w.svc.approve(requester, id);
    const requestId = r.status === "approval_required" ? r.requestId : "";
    await w.admin.approve(await w.finance(), requestId);
    await w.admin.approve(await w.finance(), requestId);
    return { id, requestId, requester };
  };

  it("resumes after a crash between the two commits, once the request is re-read and bound to this payout", async () => {
    const { id, requestId, requester } = await filed(THRESHOLD, 500);
    await w.admin.executeApproval(requester, requestId, (req) => Promise.resolve(req.id)); // first commit; the process dies before markApproved
    expect((await w.svc.get("EG", id)).status).toBe("SCHEDULED");
    expect(await w.svc.completeApproval(requester, id)).toEqual({ status: "approved" });
    expect((await w.svc.get("EG", id)).status).toBe("APPROVED");
  });

  it("refuses to resume when the consumed request belongs to another payout", async () => {
    const a = await filed(THRESHOLD, 520);
    await w.admin.executeApproval(a.requester, a.requestId, (req) => Promise.resolve(req.id));
    const b = await filed(THRESHOLD, 540);
    await w.raw.query("UPDATE payouts SET approval_request_id = $2 WHERE id = $1", [b.id, a.requestId]); // forged link
    expect(await code(w.svc.completeApproval(b.requester, b.id))).toBe("APPROVAL_NOT_READY");
    expect((await w.svc.get("EG", b.id)).status).toBe("SCHEDULED");
  });

  it("fails closed when no approval reader is configured", async () => {
    const { id, requestId, requester } = await filed(THRESHOLD, 560);
    await w.admin.executeApproval(requester, requestId, (req) => Promise.resolve(req.id));
    const bare = new PayoutService({ client: w.worker, currency: "EGP", now: () => w.clock.now, admin: w.admin, rail: w.rail, destinations: w.destinations, audit: { append: () => Promise.resolve() } });
    expect(await code(bare.completeApproval(requester, id))).toBe("APPROVAL_NOT_READY");
    expect((await bare.get("EG", id)).status).toBe("SCHEDULED");
  });
});

describe("B5: seller_order.closed must state the amount", () => {
  it("rejects a message without amount_minor (nothing is moved, the inbox row rolls back so the message can be retried)", async () => {
    const s = await w.newStore();
    const o = await w.seedOrder({ storeId: s, netMinor: 4_000n });
    await w.post("order_recognised", `order_paid:${randomUUID()}`, [["psp_clearing", 4_000n, "paymob"], ["seller_pending", -4_000n, s]]);
    const ev = await w.closeOrder({ sellerOrderId: o.sellerOrderId, storeId: s, closedAt: T0 });
    const bad: ConsumedEvent = { ...ev, payload: {} };
    expect(await code(w.mover.onSellerOrderClosed(bad))).toBe("INVALID_INPUT");
    expect(await count("SELECT count(*)::text AS n FROM inbox_processed WHERE consumer = $1 AND message_id = $2", [AVAILABILITY_CONSUMER, bad.id])).toBe(0);
    expect(await count("SELECT count(*)::text AS n FROM journal_entries WHERE idempotency_key = $1", [`line_closed:${o.sellerOrderId}`])).toBe(0);
    expect(SellerOrderClosedPayload.safeParse({}).success).toBe(false);
    expect(await w.mover.onSellerOrderClosed(ev)).toBe("processed"); // the corrected message goes through
  });
});

const dispute = (type: string, p: { sellerOrderId: string; storeId: string; disputeId: string; marketId?: string }): ConsumedEvent => ({
  id: uuidv7(), type, aggregateId: p.disputeId, marketId: "EG",
  payload: { seller_order_id: p.sellerOrderId, store_id: p.storeId, market_id: p.marketId ?? "EG", dispute_id: p.disputeId },
});

describe("B2: dispute events hold and release the disputed order", () => {
  it("dispute.opened keeps the order out of the payout, dispute.resolved releases it; redelivery and re-emission are no-ops", async () => {
    const s = await w.newStore();
    const o1 = await fundClosed(w, s, 10_000n, T0);
    const o2 = await fundClosed(w, s, 6_000n, T0);
    const disputeId = randomUUID();
    const opened = dispute(DISPUTE_OPENED_EVENT, { sellerOrderId: o1.sellerOrderId, storeId: s, disputeId });
    expect(await w.disputes.onDisputeOpened(opened)).toBe("processed");
    expect(await w.disputes.onDisputeOpened(opened)).toBe("duplicate");
    expect(await w.disputes.onDisputeOpened({ ...opened, id: uuidv7() })).toBe("processed"); // new message id, same dispute: absorbed by the unique key
    expect(await count("SELECT count(*)::text AS n FROM payout_holds WHERE source_ref = $1", [disputeId])).toBe(1);
    w.clock.now = at(600);
    const built = await w.svc.buildCycle("EG", at(600));
    const id = (await ownPayout(w, s, built.payoutIds)) ?? "";
    const p = await w.svc.get("EG", id);
    expect([p.grossMinor, p.netMinor]).toEqual([6_000n, 6_000n]); // o2 only: o1 stays held
    expect((await w.raw.query<{ status: string }>("SELECT status FROM payout_accruals WHERE seller_order_id = $1", [o1.sellerOrderId])).rows[0]?.status).toBe("AVAILABLE");
    expect(o2.sellerOrderId).not.toBe(o1.sellerOrderId);

    const resolved = dispute(DISPUTE_RESOLVED_EVENT, { sellerOrderId: o1.sellerOrderId, storeId: s, disputeId });
    expect(await w.disputes.onDisputeResolved(resolved)).toBe("processed");
    expect(await w.disputes.onDisputeResolved(resolved)).toBe("duplicate");
    expect((await w.raw.query<{ released_at: Date | null }>("SELECT released_at FROM payout_holds WHERE source_ref = $1", [disputeId])).rows[0]?.released_at).not.toBeNull();
    await w.svc.cancel("EG", id, "rebuild");
    w.clock.now = at(607);
    const again = await w.svc.buildCycle("EG", at(607));
    const id2 = (await ownPayout(w, s, again.payoutIds)) ?? "";
    expect((await w.svc.get("EG", id2)).grossMinor).toBe(16_000n);
  });

  it("a resolved that arrives before its opened leaves the order free", async () => {
    const s = await w.newStore();
    const o = await fundClosed(w, s, 5_000n, T0);
    const disputeId = randomUUID();
    expect(await w.disputes.onDisputeResolved(dispute(DISPUTE_RESOLVED_EVENT, { sellerOrderId: o.sellerOrderId, storeId: s, disputeId }))).toBe("processed");
    expect(await w.disputes.onDisputeOpened(dispute(DISPUTE_OPENED_EVENT, { sellerOrderId: o.sellerOrderId, storeId: s, disputeId }))).toBe("processed");
    expect(await count("SELECT count(*)::text AS n FROM payout_holds WHERE source_ref = $1 AND released_at IS NULL", [disputeId])).toBe(0);
  });

  it("rejects malformed payloads and a market that differs from the event", async () => {
    const s = await w.newStore();
    const o = await fundClosed(w, s, 3_000n, T0);
    const good = dispute(DISPUTE_OPENED_EVENT, { sellerOrderId: o.sellerOrderId, storeId: s, disputeId: randomUUID() });
    expect(await code(w.disputes.onDisputeOpened({ ...good, payload: { seller_order_id: "x" } }))).toBe("INVALID_INPUT");
    expect(await code(w.disputes.onDisputeResolved({ ...good, payload: {} }))).toBe("INVALID_INPUT");
    expect(await code(w.disputes.onDisputeOpened(dispute(DISPUTE_OPENED_EVENT, { sellerOrderId: o.sellerOrderId, storeId: s, disputeId: randomUUID(), marketId: "SA" })))).toBe("INVALID_INPUT");
    expect(DisputeEventPayload.safeParse(good.payload).success).toBe(true);
  });
});

describe("B4: only the money jobs may post to the ledger as outlet_worker", () => {
  const entry = (key: string): Parameters<typeof Ledger.post>[1] => ({
    kind: "clearing_settled", idempotencyKey: key, marketId: "EG", occurredAt: T0, ref: { type: "test", id: key },
    postings: [
      { accountCode: accountCode({ type: "psp_clearing", market: "EG", currency: "EGP", owner: "paymob" }), amount: money(100n, "EGP") },
      { accountCode: accountCode({ type: "bank_collections", market: "EG", currency: "EGP", owner: "main" }), amount: money(-100n, "EGP") },
    ],
  });
  it("posts in finance.payouts and finance.reconcile, is refused in every other job", async () => {
    for (const job of ["finance.payouts", "finance.reconcile"] as const) {
      await withDbContext(w.worker, { kind: "worker", marketId: "EG", job }, (tx) => Ledger.post(tx, entry(`b4-ok:${job}`)));
    }
    for (const job of ["outbox.relay", "seller.kyc", "auth.purge", "media.platform", "privacy.retention"] as const) {
      const err = await withDbContext(w.worker, { kind: "worker", marketId: "EG", job }, (tx) => Ledger.post(tx, entry(`b4-no:${job}`))).then(() => null, (e: unknown) => (e instanceof Error ? e.message : String(e)));
      expect(err, job).toMatch(/may not post to the ledger/);
    }
    expect(await count("SELECT count(*)::text AS n FROM journal_entries WHERE idempotency_key LIKE 'b4-no:%'")).toBe(0);
  });
});
