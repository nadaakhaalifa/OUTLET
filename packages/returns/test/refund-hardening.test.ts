import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withDbContext } from "@outlet/db";
import { Ledger } from "@outlet/ledger";
import { money } from "@outlet/money";
import type { Principal } from "@outlet/policy";
import { checkEligibility, windowEnd } from "../src/index.js";
import type { ReturnsConfig } from "../src/index.js";
import { DAY, T0, buildWorld, errCode } from "./fixtures.js";
import type { Order, World } from "./fixtures.js";

let w: World;
beforeAll(async () => { w = await buildWorld(); });
afterAll(async () => { await w.close(); });

type Reason = Parameters<World["returns"]["request"]>[1]["reason"];
const THRESH: Partial<ReturnsConfig> = { dualApproval: { thresholdMinor: 5_000n } };

const flow = async (svc: ReturnType<World["make"]>, userId: string, storeId: string, o: Order, opts: { reason?: Reason; refundChoice?: "original" | "store_credit"; line?: number } = {}) => {
  const line = opts.line ?? 0;
  const ret = await svc.returns.request(userId, { items: [{ orderLineId: o.lineIds[line] ?? "", qty: 1 }], reason: opts.reason ?? "changed_mind", method: "pickup", idempotencyKey: randomUUID(), ...(opts.refundChoice === undefined ? {} : { refundChoice: opts.refundChoice }) });
  const s = w.seller(storeId);
  await svc.returns.receive(s, storeId, ret.id);
  await svc.returns.inspect(s, storeId, ret.id, { result: "accepted", items: [{ orderLineId: o.lineIds[line] ?? "", condition: "as_new", restock: "restock" }] });
  const refund = await svc.refunds.createForReturn(ret.id);
  return { ret, refund };
};
const fin = (): Principal => w.admin(["finance"]);
const bal = async (code: string): Promise<bigint> => (await Ledger.balance(w.raw, code)).amountMinor;
const trial = async (): Promise<bigint> => (await Ledger.trialBalance(w.raw, "EG", "EGP")).amountMinor;
const status = async (id: string): Promise<string> => (await w.raw.query<{ status: string }>("SELECT status FROM refunds WHERE id = $1", [id])).rows[0]?.status ?? "";

describe("A1 refund dual approval via admin-access", () => {
  it("above the threshold a single admin cannot approve; requester + two other approvers can; the request is consumed once", async () => {
    const [a] = w.stores;
    const svc = w.make(THRESH);
    const u = await w.newUser();
    const o = await w.order({ userId: u, storeId: a, lines: [{ price: 10_000n }], deliveredDaysAgo: 1 });
    const { refund } = await flow(svc, u, a, o);
    expect(refund?.status).toBe("REQUESTED");
    const id = refund?.id ?? "";
    const x = fin();
    const filed = await svc.refunds.approve(x, id);
    expect(filed.status).toBe("approval_required");
    const requestId = filed.status === "approval_required" ? filed.requestId : "";
    // one admin alone: still not approved, and cannot vote on its own request
    expect(await errCode(svc.refunds.approve(x, id))).toBe("approval_required");
    expect(await errCode(w.adminAccess.approve(x, requestId))).toBe("SELF_APPROVAL");
    expect(await errCode(svc.refunds.process(id))).toBe("approval_required");
    const y = fin();
    const z = fin();
    await w.adminAccess.approve(y, requestId);
    expect(await errCode(svc.refunds.approve(x, id))).toBe("approval_required"); // one vote of two
    await w.adminAccess.approve(z, requestId);
    expect(await svc.refunds.approve(x, id)).toEqual({ status: "approved" });
    expect(await status(id)).toBe("APPROVED");
    expect(await errCode(svc.refunds.approve(x, id))).toBe("invalid_state");
    expect((await svc.refunds.process(id)).status).toBe("COMPLETED");
  });
  it("below the threshold no approval request exists and the refund is approved at once", async () => {
    const [a] = w.stores;
    const u = await w.newUser();
    const o = await w.order({ userId: u, storeId: a, lines: [{ price: 10_000n }], deliveredDaysAgo: 1 });
    const { refund } = await flow(w.make(), u, a, o);
    expect(refund?.status).toBe("APPROVED");
    const n = await w.raw.query("SELECT 1 FROM approval_requests WHERE target_id = $1", [refund?.id]);
    expect(n.rows.length).toBe(0);
  });
  it("manual resolution is dual-approved, bound to the bank reference, and drains the payable", async () => {
    const [a] = w.stores;
    const svc = w.make(THRESH);
    const u = await w.newUser();
    const o = await w.order({ userId: u, storeId: a, lines: [{ price: 10_000n }], method: "cod", deliveredDaysAgo: 1 });
    const { refund } = await flow(svc, u, a, o, { refundChoice: "original" });
    const id = refund?.id ?? "";
    const x = fin();
    const ap = await svc.refunds.approve(x, id);
    const ar = ap.status === "approval_required" ? ap.requestId : "";
    await w.adminAccess.approve(fin(), ar);
    await w.adminAccess.approve(fin(), ar);
    await svc.refunds.approve(x, id);
    expect((await svc.refunds.process(id)).status).toBe("MANUAL_REVIEW");
    const payableBefore = await bal("shopper_refunds_payable:EG:EGP");
    const filed = await svc.refunds.resolveManually(x, id, "TRX-1");
    expect(filed.status).toBe("approval_required");
    const rid = filed.status === "approval_required" ? filed.requestId : "";
    expect(await errCode(svc.refunds.resolveManually(x, id, "TRX-1"))).toBe("approval_required");
    await w.adminAccess.approve(fin(), rid);
    await w.adminAccess.approve(fin(), rid);
    expect(await errCode(svc.refunds.resolveManually(x, id, "TRX-OTHER"))).toBe("approval_required"); // not the approved reference
    const done = await svc.refunds.resolveManually(x, id, "TRX-1");
    expect(done.status === "completed" && done.refund.status).toBe("COMPLETED");
    expect(await bal("shopper_refunds_payable:EG:EGP")).toBe(payableBefore + 10_000n);
    expect(await bal("bank_collections:EG:EGP:main")).toBeLessThanOrEqual(-10_000n);
    expect(await trial()).toBe(0n);
  });
});

describe("A2 seller account is decided at process time", () => {
  it("a line that closes between create and process is debited from seller_available; seller_pending never goes negative", async () => {
    const [a] = w.stores;
    const svc = w.make();
    const u = await w.newUser();
    const o = await w.order({ userId: u, storeId: a, lines: [{ price: 10_000n }], deliveredDaysAgo: 1 });
    const { refund } = await flow(svc, u, a, o);
    const pendingBefore = await bal(`seller_pending:EG:EGP:${a}`);
    // the availability mover closes the line now
    const net = BigInt((await w.raw.query<{ n: string }>("SELECT seller_net_minor::text AS n FROM seller_orders WHERE id = $1", [o.sellerOrderId])).rows[0]?.n ?? "0");
    await w.raw.transaction(async (tx) => {
      await Ledger.post(tx, {
        kind: "line_closed", idempotencyKey: `line_closed:${o.sellerOrderId}`, marketId: "EG", occurredAt: new Date(T0), ref: { type: "seller_order", id: o.sellerOrderId },
        postings: [{ accountCode: `seller_pending:EG:EGP:${a}`, amount: money(net, "EGP") }, { accountCode: `seller_available:EG:EGP:${a}`, amount: money(-net, "EGP") }],
      });
    });
    expect((await svc.refunds.process(refund?.id ?? "")).status).toBe("COMPLETED");
    const row = (await w.raw.query<{ seller_account: string }>("SELECT seller_account FROM refunds WHERE id = $1", [refund?.id])).rows[0];
    expect(row?.seller_account).toBe("seller_available");
    // the seller's pending balance is exactly what it was minus the closed net: never a debit balance
    expect(await bal(`seller_pending:EG:EGP:${a}`)).toBeLessThanOrEqual(0n);
    expect(await bal(`seller_pending:EG:EGP:${a}`)).toBe(pendingBefore + net);
    expect(await trial()).toBe(0n);
  });
});

describe("A3 final provider rejection", () => {
  it("reverses the refund entry, waits in MANUAL_REVIEW, and manual resolution re-books and pays it; trial balance stays 0", async () => {
    const [a] = w.stores;
    const svc = w.make();
    const u = await w.newUser();
    const o = await w.order({ userId: u, storeId: a, lines: [{ price: 10_000n }], deliveredDaysAgo: 1 });
    const { refund } = await flow(svc, u, a, o);
    const id = refund?.id ?? "";
    const pendingBefore = await bal(`seller_pending:EG:EGP:${a}`);
    w.fakes.provider.script.push({ outcome: "rejected", code: "card_closed" });
    expect((await svc.refunds.process(id)).status).toBe("MANUAL_REVIEW");
    const rev = await w.raw.query("SELECT 1 FROM journal_entries e JOIN journal_entries o ON o.id = e.reverses_entry_id WHERE o.idempotency_key = $1", [`refund:${id}`]);
    expect(rev.rows.length).toBe(1);
    expect(await bal(`seller_pending:EG:EGP:${a}`)).toBe(pendingBefore); // unwound
    expect(await trial()).toBe(0n);
    const payable0 = await bal("shopper_refunds_payable:EG:EGP");
    const done = await svc.refunds.resolveManually(fin(), id, "BANK-777");
    expect(done.status === "completed" && done.refund.status).toBe("COMPLETED");
    expect(await bal("shopper_refunds_payable:EG:EGP")).toBe(payable0);
    expect((await w.raw.query<{ m: string }>("SELECT manual_ref AS m FROM refunds WHERE id = $1", [id])).rows[0]?.m).toBe("BANK-777");
    expect(await trial()).toBe(0n);
  });
});

describe("A4 job-pinned worker RLS", () => {
  it("another worker job cannot read or insert refunds for a shopper; finance.refunds can", async () => {
    const [a] = w.stores;
    const u = await w.newUser();
    const o = await w.order({ userId: u, storeId: a, lines: [{ price: 10_000n }], deliveredDaysAgo: 1 });
    const insert = (job: "finance.refunds" | "finance.payouts") => withDbContext(w.workerClient, { kind: "worker", marketId: "EG", job, userId: u }, async (tx) => {
      await tx.query(
        `INSERT INTO refunds (id, order_group_id, seller_order_id, user_id, store_id, market_id, reason, route, currency, amount_minor, goods_minor, commission_minor, commission_vat_minor, seller_minor, seller_account, destinations, status, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,'EG','goodwill','store_credit','EGP',100,100,0,0,100,'seller_pending','[]'::jsonb,'REQUESTED',$6)`,
        [randomUUID(), o.groupId, o.sellerOrderId, u, a, randomUUID()],
      );
    });
    await expect(insert("finance.payouts")).rejects.toThrow();
    await expect(insert("finance.refunds")).resolves.toBeUndefined();
    const seen = await withDbContext(w.workerClient, { kind: "worker", marketId: "EG", job: "finance.payouts", userId: u }, async (tx) => (await tx.query("SELECT 1 FROM return_requests")).rows.length);
    expect(seen).toBe(0);
  });
});

describe("A5 window edges at the end of the Cairo day", () => {
  const delivered = new Date("2030-01-01T10:00:00Z"); // 12:00 Cairo (UTC+2)
  const base = { reason: "changed_mind" as const, deliveredAt: delivered, nonReturnable: false, disclosedDefect: false, evidenceCount: 0 };
  it("23:59:59 Cairo on day 14 is allowed, 00:00:00 on day 15 is refused (winter)", () => {
    expect(checkEligibility({ ...base, now: new Date("2030-01-15T21:59:59Z") }).ok).toBe(true);
    expect(checkEligibility({ ...base, now: new Date("2030-01-15T22:00:00Z") })).toEqual({ ok: false, code: "window_closed" });
  });
  it("the same edges hold in summer time (UTC+3) and for the 30-day defect window", () => {
    const d = new Date("2030-07-01T10:00:00Z");
    expect(checkEligibility({ ...base, deliveredAt: d, now: new Date("2030-07-15T20:59:59Z") }).ok).toBe(true);
    expect(checkEligibility({ ...base, deliveredAt: d, now: new Date("2030-07-15T21:00:00Z") })).toEqual({ ok: false, code: "window_closed" });
    expect(windowEnd(delivered, 30).toISOString()).toBe("2030-01-31T21:59:59.999Z");
    expect(checkEligibility({ ...base, reason: "defect_worse_than_shown", evidenceCount: 1, now: new Date("2030-01-31T21:59:59Z") }).ok).toBe(true);
    expect(checkEligibility({ ...base, reason: "defect_worse_than_shown", evidenceCount: 1, now: new Date("2030-01-31T22:00:00Z") })).toEqual({ ok: false, code: "window_closed" });
  });
});

describe("A6 zero refund", () => {
  it("a fully discounted unit closes the return with no refund row and no error", async () => {
    const [a] = w.stores;
    const svc = w.make();
    const u = await w.newUser();
    const o = await w.order({ userId: u, storeId: a, lines: [{ price: 10_000n, discount: 10_000n }, { price: 5_000n }], deliveredDaysAgo: 1 });
    const { ret, refund } = await flow(svc, u, a, o, { line: 0 });
    expect(refund).toBeNull();
    expect((await w.raw.query<{ status: string }>("SELECT status FROM return_requests WHERE id = $1", [ret.id])).rows[0]?.status).toBe("CLOSED");
    expect((await w.raw.query("SELECT 1 FROM refunds WHERE return_request_id = $1", [ret.id])).rows.length).toBe(0);
  });
});

describe("A7 restock via outbox + inbox", () => {
  it("a failing restock is redelivered and retried; a duplicate delivery is a no-op", async () => {
    const [a] = w.stores;
    const svc = w.make();
    const u = await w.newUser();
    const o = await w.order({ userId: u, storeId: a, lines: [{ price: 10_000n }], deliveredDaysAgo: 1 });
    const before = w.fakes.restock.applied.length;
    const { ret } = await flow(svc, u, a, o);
    const ev = (await w.raw.query<{ id: string; payload: Record<string, unknown> }>("SELECT id, payload FROM outbox_events WHERE event_type = 'return.restock_requested' AND payload->>'return_request_id' = $1", [ret.id])).rows;
    expect(ev.length).toBe(1);
    expect(w.fakes.restock.applied.length).toBe(before); // nothing happens post-commit any more
    const e = ev[0];
    if (e === undefined) throw new Error("no event");
    const orig = w.fakes.restock.apply.bind(w.fakes.restock);
    w.fakes.restock.apply = () => Promise.reject(new Error("warehouse down"));
    await expect(svc.returns.consumeRestock(e.id, e.payload)).rejects.toThrow("warehouse down");
    w.fakes.restock.apply = orig;
    expect((await w.raw.query("SELECT 1 FROM inbox_processed WHERE message_id = $1", [e.id])).rows.length).toBe(0);
    expect(await svc.returns.consumeRestock(e.id, e.payload)).toBe("processed");
    expect(await svc.returns.consumeRestock(e.id, e.payload)).toBe("duplicate");
    expect(w.fakes.restock.applied.length).toBe(before + 1);
  });
});

describe("A8 serial returner numerator", () => {
  const ten = async (u: string, a: string): Promise<Order[]> => {
    const out: Order[] = [];
    for (let i = 0; i < 10; i += 1) out.push(await w.order({ userId: u, storeId: a, lines: [{ price: 10_000n }], deliveredDaysAgo: 1 }));
    return out;
  };
  const serialOf = async (id: string): Promise<boolean> => (await w.raw.query<{ s: boolean }>("SELECT serial_returner AS s FROM return_requests WHERE id = $1", [id])).rows[0]?.s ?? false;
  it("rejected-and-closed returns do not count; accepted returns do", async () => {
    const [a] = w.stores;
    const svc = w.make();
    const s = w.seller(a);
    const u1 = await w.newUser();
    const o1 = await ten(u1, a);
    for (const o of o1.slice(0, 7)) {
      const r = await svc.returns.request(u1, { items: [{ orderLineId: o.lineIds[0] ?? "", qty: 1 }], reason: "changed_mind", method: "pickup", idempotencyKey: randomUUID() });
      await svc.returns.receive(s, a, r.id);
      await svc.returns.inspect(s, a, r.id, { result: "rejected", reasonCode: "worn" });
    }
    w.clock.t = T0 + 15 * DAY;
    expect((await svc.returns.closeRejected()).length).toBe(7);
    w.clock.t = T0;
    const last = o1[9];
    const probe = await svc.returns.request(u1, { items: [{ orderLineId: last?.lineIds[0] ?? "", qty: 1 }], reason: "changed_mind", method: "pickup", idempotencyKey: randomUUID() });
    expect(await serialOf(probe.id)).toBe(false);

    const u2 = await w.newUser();
    const o2 = await ten(u2, a);
    for (const o of o2.slice(0, 7)) {
      const r = await svc.returns.request(u2, { items: [{ orderLineId: o.lineIds[0] ?? "", qty: 1 }], reason: "changed_mind", method: "pickup", idempotencyKey: randomUUID() });
      await svc.returns.receive(s, a, r.id);
      await svc.returns.inspect(s, a, r.id, { result: "accepted" });
    }
    const probe2 = await svc.returns.request(u2, { items: [{ orderLineId: o2[9]?.lineIds[0] ?? "", qty: 1 }], reason: "changed_mind", method: "pickup", idempotencyKey: randomUUID() });
    expect(await serialOf(probe2.id)).toBe(true);
  });
});

describe("A10 closeRejected and dispute SLA breach", () => {
  it("an undisputed rejection closes after the configured days; a disputed one does not; SLA breach is flagged once", async () => {
    const [a] = w.stores;
    const svc = w.make();
    const s = w.seller(a);
    const u = await w.newUser();
    const mk = async (): Promise<string> => {
      const o = await w.order({ userId: u, storeId: a, lines: [{ price: 10_000n }], deliveredDaysAgo: 1 });
      const r = await svc.returns.request(u, { items: [{ orderLineId: o.lineIds[0] ?? "", qty: 1 }], reason: "changed_mind", method: "pickup", idempotencyKey: randomUUID() });
      await svc.returns.receive(s, a, r.id);
      await svc.returns.inspect(s, a, r.id, { result: "rejected", reasonCode: "worn" });
      return r.id;
    };
    const quiet = await mk();
    const disputed = await mk();
    const d = await svc.returns.openDispute(u, disputed, { reasonCode: "rejection_unjustified" });
    w.clock.t = T0 + 5 * DAY;
    expect(await svc.returns.closeRejected()).not.toContain(quiet); // too early
    w.clock.t = T0 + 20 * DAY;
    const closed = await svc.returns.closeRejected();
    expect(closed).toContain(quiet);
    expect(closed).not.toContain(disputed);
    expect(await svc.returns.flagDisputeSlaBreaches()).toContain(d.disputeId);
    expect(await svc.returns.flagDisputeSlaBreaches()).not.toContain(d.disputeId);
    expect((await w.raw.query("SELECT 1 FROM outbox_events WHERE event_type = 'dispute.sla_breached' AND aggregate_id = $1", [d.disputeId])).rows.length).toBe(1);
    w.clock.t = T0;
  });
});
