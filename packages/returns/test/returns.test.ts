import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertTenantTablesProtected } from "@outlet/db";
import { Ledger } from "@outlet/ledger";
import { money } from "@outlet/money";
import { DISPUTE_OPENED_EVENT, DISPUTE_RESOLVED_EVENT, DisputeEventPayload } from "@outlet/payouts";
import type { RefundView, ReturnView } from "../src/index.js";
import { DAY, buildWorld, errCode } from "./fixtures.js";
import type { Order, World } from "./fixtures.js";

let w: World;
beforeAll(async () => {
  w = await buildWorld();
});
afterAll(async () => {
  await w.close();
});

const photo = [randomUUID()];
const req = (userId: string, o: Order, reason: Parameters<World["returns"]["request"]>[1]["reason"], extra: Partial<Parameters<World["returns"]["request"]>[1]> = {}, lineIdx = 0, qty = 1) =>
  w.returns.request(userId, { items: [{ orderLineId: o.lineIds[lineIdx] ?? "", qty }], reason, method: "pickup", idempotencyKey: randomUUID(), ...extra });

/** request -> received -> inspected (accepted) -> refund created, as the real consumers would. */
const accepted = async (userId: string, storeId: string, o: Order, reason: Parameters<World["returns"]["request"]>[1]["reason"] = "changed_mind", extra: Partial<Parameters<World["returns"]["request"]>[1]> = {}, lineIdx = 0, qty = 1): Promise<{ ret: ReturnView; refund: RefundView }> => {
  const ret = await req(userId, o, reason, extra, lineIdx, qty);
  const s = w.seller(storeId);
  await w.returns.receive(s, storeId, ret.id);
  await w.returns.inspect(s, storeId, ret.id, { result: "accepted", items: [{ orderLineId: o.lineIds[lineIdx] ?? "", condition: "as_new", restock: "restock" }] });
  const refund = await w.refunds.createForReturn(ret.id);
  if (refund === null) throw new Error("expected a refund");
  return { ret, refund };
};

const entryOf = async (refundId: string): Promise<Map<string, bigint>> => {
  const r = await w.raw.query<{ code: string; amount: string }>(
    `SELECT a.code, p.amount_minor::text AS amount FROM journal_entries e JOIN postings p ON p.entry_id = e.id JOIN ledger_accounts a ON a.id = p.account_id WHERE e.idempotency_key = $1`, [`refund:${refundId}`],
  );
  return new Map(r.rows.map((x) => [x.code, BigInt(x.amount)]));
};
const status = async (table: "refunds" | "return_requests", id: string): Promise<string> => (await w.raw.query<{ status: string }>(`SELECT status FROM ${table} WHERE id = $1`, [id])).rows[0]?.status ?? "";

describe("request rules", () => {
  it("day-15 change of mind is refused; day-14 is accepted", async () => {
    const [a] = w.stores;
    const u = await w.newUser();
    const late = await w.order({ userId: u, storeId: a, lines: [{ price: 10_000n }], deliveredDaysAgo: 15 });
    expect(await errCode(req(u, late, "changed_mind"))).toBe("window_closed");
    const ok = await w.order({ userId: u, storeId: a, lines: [{ price: 10_000n }], deliveredDaysAgo: 14 });
    expect((await req(u, ok, "changed_mind")).status).toBe("APPROVED");
  });
  it("day-29 defect is accepted (30-day window) with photos; photos are required", async () => {
    const [a] = w.stores;
    const u = await w.newUser();
    const o = await w.order({ userId: u, storeId: a, lines: [{ price: 10_000n }], deliveredDaysAgo: 29 });
    expect(await errCode(req(u, o, "defect_worse_than_shown"))).toBe("photos_required");
    w.fakes.evidence.ready = false;
    expect(await errCode(req(u, o, "defect_worse_than_shown", { evidenceMediaIds: photo }))).toBe("evidence_invalid");
    w.fakes.evidence.ready = true;
    const r = await req(u, o, "defect_worse_than_shown", { evidenceMediaIds: photo });
    expect(r.status).toBe("APPROVED");
    const ev = await w.raw.query("SELECT 1 FROM return_evidence WHERE return_request_id = $1", [r.id]);
    expect(ev.rows.length).toBe(1);
  });
  it("a disclosed, acknowledged defect is not a return reason; worse-than-shown still is", async () => {
    const [a] = w.stores;
    const u = await w.newUser();
    const o = await w.order({ userId: u, storeId: a, lines: [{ price: 10_000n, disclosedDefect: true }], deliveredDaysAgo: 2 });
    expect(await errCode(req(u, o, "defect_undisclosed", { evidenceMediaIds: photo }))).toBe("disclosed_defect");
    expect((await req(u, o, "defect_worse_than_shown", { evidenceMediaIds: photo })).status).toBe("APPROVED");
  });
  it("refuses undelivered orders, non-returnable categories, and over-returning across requests", async () => {
    const [a] = w.stores;
    const u = await w.newUser();
    const undelivered = await w.order({ userId: u, storeId: a, lines: [{ price: 10_000n }], deliveredDaysAgo: null });
    expect(await errCode(req(u, undelivered, "changed_mind"))).toBe("not_delivered");
    const o = await w.order({ userId: u, storeId: a, lines: [{ price: 5_000n, qty: 2 }, { price: 7_000n }], deliveredDaysAgo: 1 });
    w.fakes.policy.excluded.add(o.skuIds[1] ?? "");
    expect(await errCode(req(u, o, "changed_mind", {}, 1))).toBe("non_returnable");
    w.fakes.policy.excluded.clear();
    await req(u, o, "changed_mind", {}, 0, 1);
    expect(await errCode(req(u, o, "changed_mind", {}, 0, 2))).toBe("qty_exceeds_purchased");
  });
  it("is idempotent on the client key and exchange-first for size reasons", async () => {
    const [a] = w.stores;
    const u = await w.newUser();
    const o = await w.order({ userId: u, storeId: a, lines: [{ price: 10_000n }], deliveredDaysAgo: 1 });
    const key = randomUUID();
    const one = await req(u, o, "changed_mind", { idempotencyKey: key });
    const two = await req(u, o, "changed_mind", { idempotencyKey: key });
    expect([two.id, two.replayed]).toEqual([one.id, true]);
    const o2 = await w.order({ userId: u, storeId: a, lines: [{ price: 10_000n }], deliveredDaysAgo: 1 });
    w.fakes.policy.swap = true;
    expect((await req(u, o2, "too_small")).resolution).toBe("exchange");
    w.fakes.policy.swap = false;
  });
  it("flags a serial returner by the published policy and removes free returns", async () => {
    const [a] = w.stores;
    const { returns, refunds } = w.make({ serialMinOrders: 2, serialRatePercent: 40 });
    const u = await w.newUser();
    const o1 = await w.order({ userId: u, storeId: a, lines: [{ price: 10_000n }], deliveredDaysAgo: 3 });
    const o2 = await w.order({ userId: u, storeId: a, lines: [{ price: 10_000n }], deliveredDaysAgo: 3 });
    const r1 = await returns.request(u, { items: [{ orderLineId: o1.lineIds[0] ?? "", qty: 1 }], reason: "changed_mind", method: "pickup", idempotencyKey: randomUUID() });
    const s = w.seller(a);
    await returns.receive(s, a, r1.id);
    await returns.inspect(s, a, r1.id, { result: "accepted" });
    await refunds.createForReturn(r1.id);
    const r2 = await returns.request(u, { items: [{ orderLineId: o2.lineIds[0] ?? "", qty: 1 }], reason: "changed_mind", method: "pickup", idempotencyKey: randomUUID() });
    const row = (await w.raw.query<{ serial_returner: boolean; return_shipping_payer: string }>("SELECT serial_returner, return_shipping_payer FROM return_requests WHERE id = $1", [r2.id])).rows[0];
    expect(row).toEqual({ serial_returner: true, return_shipping_payer: "shopper" });
  });
});

describe("refund amounts and ledger-first entries", () => {
  it("partial refund matches ledger spec 4.5 (seller 24,870 / commission 4,500 / VAT 630 / PSP 30,000) and balances", async () => {
    const [, b] = w.stores;
    const u = await w.newUser();
    const o = await w.order({ userId: u, storeId: b, lines: [{ price: 59_950n }, { price: 30_000n }], deliveredDaysAgo: 2 });
    const { refund } = await accepted(u, b, o, "changed_mind", {}, 1);
    const done = await w.refunds.process(refund.id);
    expect([done.status, done.route, done.amount.amountMinor]).toEqual(["COMPLETED", "psp_original", 30_000n]);
    const e = await entryOf(refund.id);
    expect(e.get(`seller_pending:EG:EGP:${b}`)).toBe(24_870n);
    expect(e.get("commission_revenue:EG:EGP")).toBe(4_500n);
    expect(e.get("platform_vat_output:EG:EGP")).toBe(630n);
    expect(e.get("psp_clearing:EG:EGP:paymob")).toBe(-30_000n);
    expect(w.fakes.provider.calls.at(-1)?.amount.amountMinor).toBe(30_000n);
    expect(await status("return_requests", (await w.raw.query<{ return_request_id: string }>("SELECT return_request_id FROM refunds WHERE id = $1", [refund.id])).rows[0]?.return_request_id ?? "")).toBe("CLOSED");
    // second partial refund on the same order differences from the remaining base: total commission reproduced exactly (I10)
    const second = await accepted(u, b, o, "changed_mind", {}, 0);
    await w.refunds.process(second.refund.id);
    const rows = (await w.raw.query<{ c: string; v: string; s: string }>("SELECT SUM(commission_minor)::text AS c, SUM(commission_vat_minor)::text AS v, SUM(seller_minor)::text AS s FROM refunds WHERE seller_order_id = $1", [o.sellerOrderId])).rows[0];
    expect(rows).toEqual({ c: "13492", v: "1889", s: String(89_950 - 13_492 - 1_889) });
    expect((await Ledger.trialBalance(w.raw, "EG", "EGP")).amountMinor).toBe(0n);
  });

  it("gives the delivery fee back only when the seller is at fault (defect), with its VAT", async () => {
    const [a] = w.stores;
    const u = await w.newUser();
    const fault = await w.order({ userId: u, storeId: a, lines: [{ price: 20_000n }, { price: 5_000n }], shipping: 4_000n, shippingVat: 491n, deliveredDaysAgo: 20 });
    const { refund } = await accepted(u, a, fault, "defect_undisclosed", { evidenceMediaIds: photo }, 1);
    expect(refund.amount.amountMinor).toBe(9_000n);
    await w.refunds.process(refund.id);
    const e = await entryOf(refund.id);
    expect(e.get("shipping_revenue:EG:EGP")).toBe(3_509n);
    expect(e.get("platform_vat_output:EG:EGP")).toBe(491n + 105n); // delivery VAT + VAT on commission(750)=105
    const mind = await w.order({ userId: u, storeId: a, lines: [{ price: 20_000n }, { price: 5_000n }], shipping: 4_000n, shippingVat: 491n, deliveredDaysAgo: 20 - 19 });
    const second = await accepted(u, a, mind, "changed_mind", {}, 1);
    expect(second.refund.amount.amountMinor).toBe(5_000n);
  });

  it("returns the proportional voucher share only: refund = price minus discount share", async () => {
    const [a] = w.stores;
    const u = await w.newUser();
    const o = await w.order({ userId: u, storeId: a, lines: [{ price: 10_000n, qty: 3, discount: 1_000n }], deliveredDaysAgo: 1 });
    const one = await accepted(u, a, o, "changed_mind", {}, 0, 1);
    const two = await accepted(u, a, o, "changed_mind", {}, 0, 2);
    expect([one.refund.amount.amountMinor, two.refund.amount.amountMinor]).toEqual([9_667n, 19_333n]); // 3 x 10,000 - 1,000 = 29,000
    expect(one.refund.amount.amountMinor + two.refund.amount.amountMinor).toBe(29_000n);
  });

  it("after the line closed the seller's AVAILABLE balance is debited and refund.after_payout is emitted for payout netting", async () => {
    const [a] = w.stores;
    const u = await w.newUser();
    const o = await w.order({ userId: u, storeId: a, lines: [{ price: 10_000n }], deliveredDaysAgo: 20, closed: true });
    const { refund } = await accepted(u, a, o, "defect_undisclosed", { evidenceMediaIds: photo });
    await w.refunds.process(refund.id);
    expect((await entryOf(refund.id)).has(`seller_available:EG:EGP:${a}`)).toBe(true);
    const ev = await w.raw.query("SELECT 1 FROM outbox_events WHERE event_type = 'refund.after_payout' AND aggregate_id = $1", [refund.id]);
    expect(ev.rows.length).toBe(1);
  });

  it("never refunds more than was paid", async () => {
    const [a] = w.stores;
    const u = await w.newUser();
    const o = await w.order({ userId: u, storeId: a, lines: [{ price: 10_000n }], deliveredDaysAgo: 1 });
    await accepted(u, a, o);
    expect(await errCode(req(u, o, "changed_mind"))).toBe("qty_exceeds_purchased");
  });
});

describe("router branches end to end", () => {
  it("BNPL: provider cancellation only, credited to bnpl_clearing, never store credit", async () => {
    const [a] = w.stores;
    const u = await w.newUser();
    const o = await w.order({ userId: u, storeId: a, lines: [{ price: 10_000n }], method: "bnpl", bnplProvider: "valu", deliveredDaysAgo: 1 });
    const before = w.fakes.provider.calls.length;
    const { refund } = await accepted(u, a, o);
    await w.refunds.process(refund.id);
    expect(w.fakes.provider.calls.slice(before).map((c) => c.route)).toEqual(["bnpl_provider"]);
    const e = await entryOf(refund.id);
    expect(e.get("bnpl_clearing:EG:EGP:valu")).toBe(-10_000n);
    expect([...e.keys()].some((k) => k.startsWith("store_credit"))).toBe(false);
    const o2 = await w.order({ userId: u, storeId: a, lines: [{ price: 10_000n }], method: "bnpl", bnplProvider: "valu", deliveredDaysAgo: 1 });
    // refused at REQUEST time (422), not at refund time; the original-method choice still works
    expect(await errCode(req(u, o2, "changed_mind", { refundChoice: "store_credit" }))).toBe("request_bnpl_provider_only");
    expect((await req(u, o2, "changed_mind", { refundChoice: "original" })).status).toBe("APPROVED");
  });
  it("COD: instant store credit by default (no provider call), completes with the ledger entry", async () => {
    const [a] = w.stores;
    const u = await w.newUser();
    const o = await w.order({ userId: u, storeId: a, lines: [{ price: 10_000n }], method: "cod", deliveredDaysAgo: 1 });
    const before = w.fakes.provider.calls.length;
    const { refund } = await accepted(u, a, o);
    const done = await w.refunds.process(refund.id);
    expect([done.status, done.route]).toEqual(["COMPLETED", "store_credit"]);
    expect(w.fakes.provider.calls.length).toBe(before);
    expect((await entryOf(refund.id)).get(`store_credit:EG:EGP:${u}:refund_credit`)).toBe(-10_000n);
    expect((await Ledger.balance(w.raw, `store_credit:EG:EGP:${u}:refund_credit`)).amountMinor).toBe(-10_000n);
  });
  it("COD by shopper choice, Fawry voucher and non-reversible wallet are owed and wait in MANUAL_REVIEW for finance", async () => {
    const [a] = w.stores;
    const u = await w.newUser();
    const cod = await w.order({ userId: u, storeId: a, lines: [{ price: 10_000n }], method: "cod", deliveredDaysAgo: 1 });
    const c = await accepted(u, a, cod, "changed_mind", { refundChoice: "original" });
    expect((await w.refunds.process(c.refund.id)).status).toBe("MANUAL_REVIEW");
    expect((await entryOf(c.refund.id)).get("shopper_refunds_payable:EG:EGP")).toBe(-10_000n);
    const fin = w.admin(["finance"]);
    const resolved = await w.refunds.resolveManually(fin, c.refund.id, "BANK-REF-1");
    expect(resolved.status === "completed" && resolved.refund.status).toBe("COMPLETED");
    // The owed leg is paid: Dr shopper_refunds_payable / Cr bank_collections drains the payable (A3).
    expect((await Ledger.balance(w.raw, "shopper_refunds_payable:EG:EGP")).amountMinor).toBe(0n);
    w.fakes.provider.reversible = false;
    const wal = await w.order({ userId: u, storeId: a, lines: [{ price: 10_000n }], method: "wallet", deliveredDaysAgo: 1 });
    const x = await accepted(u, a, wal);
    expect(x.refund.route).toBe("bank_transfer");
    w.fakes.provider.reversible = true;
    const faw = await w.order({ userId: u, storeId: a, lines: [{ price: 10_000n }], method: "fawry", deliveredDaysAgo: 1 });
    expect((await accepted(u, a, faw)).refund.route).toBe("store_credit");
  });
  it("split tender: the credit portion goes back to the same sub-balance, the rest to the PSP", async () => {
    const [a] = w.stores;
    const u = await w.newUser();
    const o = await w.order({ userId: u, storeId: a, lines: [{ price: 10_000n }], credit: 4_000n, deliveredDaysAgo: 1 });
    const { refund } = await accepted(u, a, o);
    const done = await w.refunds.process(refund.id);
    expect([done.status, done.route]).toEqual(["COMPLETED", "mixed"]);
    const e = await entryOf(refund.id);
    expect(e.get(`store_credit:EG:EGP:${u}:goodwill`)).toBe(-4_000n);
    expect(e.get("psp_clearing:EG:EGP:paymob")).toBe(-6_000n);
    expect(w.fakes.provider.calls.at(-1)?.amount.amountMinor).toBe(6_000n);
  });
});

describe("failure handling, idempotency, kill switch, approval", () => {
  it("replays are safe: one refund row, one ledger entry, one provider call", async () => {
    const [a] = w.stores;
    const u = await w.newUser();
    const o = await w.order({ userId: u, storeId: a, lines: [{ price: 10_000n }], deliveredDaysAgo: 1 });
    const { ret, refund } = await accepted(u, a, o);
    const again = await w.refunds.createForReturn(ret.id);
    expect([again?.id, again?.replayed]).toEqual([refund.id, true]);
    const before = w.fakes.provider.calls.length;
    await w.refunds.process(refund.id);
    await w.refunds.process(refund.id);
    expect(w.fakes.provider.calls.length - before).toBe(1);
    const n = await w.raw.query("SELECT 1 FROM journal_entries WHERE idempotency_key = $1", [`refund:${refund.id}`]);
    expect(n.rows.length).toBe(1);
  });
  it("retryable provider failure -> FAILED with backoff -> retried by the job -> COMPLETED; escalates to MANUAL_REVIEW after N attempts", async () => {
    const [a] = w.stores;
    const u = await w.newUser();
    const o = await w.order({ userId: u, storeId: a, lines: [{ price: 10_000n }, { price: 3_000n }], deliveredDaysAgo: 1 });
    const one = await accepted(u, a, o, "changed_mind", {}, 0);
    w.fakes.provider.script.push({ outcome: "retryable", code: "timeout" });
    expect((await w.refunds.process(one.refund.id)).status).toBe("FAILED");
    expect(await w.refunds.retryDue()).toEqual([]);
    w.clock.t += 301_000;
    expect(await w.refunds.retryDue()).toEqual([one.refund.id]);
    expect(await status("refunds", one.refund.id)).toBe("COMPLETED");
    const n = await w.raw.query("SELECT 1 FROM journal_entries WHERE idempotency_key = $1", [`refund:${one.refund.id}`]);
    expect(n.rows.length).toBe(1);

    const two = await accepted(u, a, o, "changed_mind", {}, 1);
    w.fakes.provider.script.push({ outcome: "retryable", code: "t1" }, { outcome: "retryable", code: "t2" }, { outcome: "retryable", code: "t3" });
    await w.refunds.process(two.refund.id);
    w.clock.t += 301_000;
    await w.refunds.retryDue();
    w.clock.t += 700_000;
    await w.refunds.retryDue();
    expect(await status("refunds", two.refund.id)).toBe("MANUAL_REVIEW");
    const ev = await w.raw.query("SELECT 1 FROM outbox_events WHERE event_type = 'refund.attention' AND aggregate_id = $1", [two.refund.id]);
    expect(ev.rows.length).toBeGreaterThan(0);
  });
  it("a final provider rejection goes straight to MANUAL_REVIEW", async () => {
    const [a] = w.stores;
    const u = await w.newUser();
    const o = await w.order({ userId: u, storeId: a, lines: [{ price: 10_000n }], deliveredDaysAgo: 1 });
    const { refund } = await accepted(u, a, o);
    w.fakes.provider.script.push({ outcome: "rejected", code: "card_closed" });
    expect((await w.refunds.process(refund.id)).status).toBe("MANUAL_REVIEW");
  });
  it("kill switch engaged: nothing is posted or sent, the refund stays APPROVED", async () => {
    const [a] = w.stores;
    const u = await w.newUser();
    const o = await w.order({ userId: u, storeId: a, lines: [{ price: 10_000n }], deliveredDaysAgo: 1 });
    const { refund } = await accepted(u, a, o);
    w.fakes.kill.engaged.add("refunds.enabled");
    const before = w.fakes.provider.calls.length;
    expect(await errCode(w.refunds.process(refund.id))).toBe("refunds_disabled");
    expect(w.fakes.provider.calls.length).toBe(before);
    expect((await w.raw.query("SELECT 1 FROM journal_entries WHERE idempotency_key = $1", [`refund:${refund.id}`])).rows.length).toBe(0);
    expect(await status("refunds", refund.id)).toBe("APPROVED");
    w.fakes.kill.engaged.clear();
    expect((await w.refunds.process(refund.id)).status).toBe("COMPLETED");
  });
  it("refunds at or above the dual-approval threshold wait for a stored dual-approval request (see refund-hardening.test.ts for the full flow)", async () => {
    const [a] = w.stores;
    const { returns, refunds } = w.make({ dualApproval: { thresholdMinor: 5_000n } });
    const u = await w.newUser();
    const o = await w.order({ userId: u, storeId: a, lines: [{ price: 10_000n }], deliveredDaysAgo: 1 });
    const r = await returns.request(u, { items: [{ orderLineId: o.lineIds[0] ?? "", qty: 1 }], reason: "changed_mind", method: "pickup", idempotencyKey: randomUUID() });
    const s = w.seller(a);
    await returns.receive(s, a, r.id);
    await returns.inspect(s, a, r.id, { result: "accepted" });
    const refund = await refunds.createForReturn(r.id);
    expect(refund?.status).toBe("REQUESTED");
    expect(await errCode(refunds.process(refund?.id ?? ""))).toBe("approval_required");
    expect(await errCode(refunds.approve(w.admin(["support"]), refund?.id ?? ""))).toBe("forbidden");
    expect((await refunds.approve(w.admin(["finance"]), refund?.id ?? "")).status).toBe("approval_required");
    expect(await status("refunds", refund?.id ?? "")).toBe("REQUESTED");
  });
});

describe("inspection, auto-approve, disputes", () => {
  it("silence for 48 h after receipt auto-approves; not before", async () => {
    const [a] = w.stores;
    const u = await w.newUser();
    const o = await w.order({ userId: u, storeId: a, lines: [{ price: 10_000n }], deliveredDaysAgo: 1 });
    const r = await req(u, o, "changed_mind");
    await w.returns.receive(w.seller(a), a, r.id);
    w.clock.t += 47 * 3_600_000;
    expect(await w.returns.autoApproveDue()).toEqual([]);
    w.clock.t += 2 * 3_600_000;
    expect(await w.returns.autoApproveDue()).toContain(r.id);
    expect(await status("return_requests", r.id)).toBe("ACCEPTED");
    expect((await w.raw.query<{ inspector_type: string }>("SELECT inspector_type FROM return_inspections WHERE return_request_id = $1", [r.id])).rows[0]?.inspector_type).toBe("system");
    expect(await w.returns.autoApproveDue()).not.toContain(r.id);
    expect(await errCode(w.returns.inspect(w.seller(a), a, r.id, { result: "accepted" }))).toBe("invalid_state");
  });
  it("rejection needs a reason; dispute goes to the T&S queue with a 5-business-day SLA; both outcomes", async () => {
    const [a] = w.stores;
    const u = await w.newUser();
    const o = await w.order({ userId: u, storeId: a, lines: [{ price: 10_000n }, { price: 4_000n }], deliveredDaysAgo: 1 });
    const mk = async (line: number) => {
      const r = await req(u, o, "changed_mind", {}, line);
      const s = w.seller(a);
      await w.returns.receive(s, a, r.id);
      expect(await errCode(w.returns.inspect(s, a, r.id, { result: "rejected" }))).toBe("invalid_state");
      await w.returns.inspect(s, a, r.id, { result: "rejected", reasonCode: "used_item", notes: "worn" });
      return r;
    };
    const r1 = await mk(0);
    const d1 = await w.returns.openDispute(u, r1.id, { reasonCode: "rejection_unjustified", note: "never worn" });
    const queue = await w.returns.disputeQueue(w.admin(["trust_safety"]));
    expect(queue.some((d) => d.id === d1.disputeId && d.reasonCode === "rejection_unjustified")).toBe(true);
    expect(await errCode(w.returns.disputeQueue(w.admin(["marketing"])))).toBe("forbidden");
    expect(await errCode(w.returns.resolveDispute(w.seller(a), d1.disputeId, "shopper", "x"))).toBe("forbidden");
    expect(await w.returns.resolveDispute(w.admin(["trust_safety"]), d1.disputeId, "shopper", "photos show unused")).toBe("ACCEPTED");
    const refund = await w.refunds.createForReturn(r1.id);
    expect(refund?.amount.amountMinor).toBe(10_000n);
    const r2 = await mk(1);
    const d2 = await w.returns.openDispute(u, r2.id, { reasonCode: "other" });
    expect(await w.returns.resolveDispute(w.admin(["trust_safety"]), d2.disputeId, "seller", "worn")).toBe("CLOSED");
    expect(await errCode(w.returns.resolveDispute(w.admin(["trust_safety"]), d2.disputeId, "seller", "again"))).toBe("invalid_state");
    const sla = (await w.raw.query<{ d: string }>("SELECT sla_due_at::text AS d FROM disputes WHERE id = $1", [d1.disputeId])).rows[0]?.d ?? "";
    expect(new Date(sla).getTime()).toBeGreaterThan(w.clock.t);
  });
  it("dispute.opened and dispute.resolved carry the payouts DisputeEventPayload, in the same transaction as the state change", async () => {
    const [a] = w.stores;
    const u = await w.newUser();
    const o = await w.order({ userId: u, storeId: a, lines: [{ price: 10_000n }], deliveredDaysAgo: 1 });
    const r = await req(u, o, "changed_mind");
    const s = w.seller(a);
    await w.returns.receive(s, a, r.id);
    await w.returns.inspect(s, a, r.id, { result: "rejected", reasonCode: "used_item", notes: "worn" });
    const d = await w.returns.openDispute(u, r.id, { reasonCode: "rejection_unjustified" });
    const events = async (type: string) => (await w.raw.query<{ payload: unknown }>("SELECT payload FROM outbox_events WHERE event_type = $1 AND aggregate_id = $2", [type, d.disputeId])).rows;
    const [opened] = await events(DISPUTE_OPENED_EVENT);
    const row = (await w.raw.query<{ seller_order_id: string; store_id: string }>("SELECT seller_order_id, store_id FROM return_requests WHERE id = $1", [r.id])).rows[0];
    expect(DisputeEventPayload.parse(opened?.payload)).toMatchObject({ dispute_id: d.disputeId, seller_order_id: row?.seller_order_id, store_id: a, market_id: "EG" });
    expect(await events(DISPUTE_RESOLVED_EVENT)).toHaveLength(0);
    await w.returns.resolveDispute(w.admin(["trust_safety"]), d.disputeId, "seller", "worn");
    const resolved = await events(DISPUTE_RESOLVED_EVENT);
    expect(resolved).toHaveLength(1);
    expect(DisputeEventPayload.parse(resolved[0]?.payload).dispute_id).toBe(d.disputeId);
    // a failed resolve (already resolved) emits nothing more
    expect(await errCode(w.returns.resolveDispute(w.admin(["trust_safety"]), d.disputeId, "seller", "again"))).toBe("invalid_state");
    expect(await events(DISPUTE_RESOLVED_EVENT)).toHaveLength(1);
  });
  it("restock puts the unit back on the shelf (idempotent); write-off does not", async () => {
    const [a] = w.stores;
    const { returns, refunds } = w.make(undefined, true);
    const u = await w.newUser();
    const o = await w.order({ userId: u, storeId: a, lines: [{ price: 10_000n }, { price: 4_000n }], deliveredDaysAgo: 1 });
    const onHand = async (sku: string): Promise<number> => Number((await w.raw.query<{ on_hand: number }>("SELECT on_hand FROM inventory_levels WHERE sku_id = $1", [sku])).rows[0]?.on_hand);
    const s = w.seller(a);
    const run = async (line: number, restock: "restock" | "write_off") => {
      const r = await returns.request(u, { items: [{ orderLineId: o.lineIds[line] ?? "", qty: 1 }], reason: "changed_mind", method: "pickup", idempotencyKey: randomUUID() });
      await returns.receive(s, a, r.id);
      await returns.inspect(s, a, r.id, { result: "accepted", items: [{ orderLineId: o.lineIds[line] ?? "", condition: restock === "restock" ? "as_new" : "damaged", restock }] });
      await refunds.createForReturn(r.id);
    };
    await run(0, "restock");
    await run(1, "write_off");
    const events = await w.raw.query<{ id: string; payload: Record<string, unknown> }>("SELECT id, payload FROM outbox_events WHERE event_type = 'return.restock_requested' ORDER BY id");
    for (const e of events.rows) await returns.consumeRestock(e.id, e.payload);
    for (const e of events.rows) expect(await returns.consumeRestock(e.id, e.payload)).toBe("duplicate");
    expect([await onHand(o.skuIds[0] ?? ""), await onHand(o.skuIds[1] ?? "")]).toEqual([6, 5]);
  });
});

describe("tenant isolation and authorization", () => {
  it("shopper B cannot see or return shopper A's order; the answer is 404, never 403", async () => {
    const [a] = w.stores;
    const ua = await w.newUser();
    const ub = await w.newUser();
    const o = await w.order({ userId: ua, storeId: a, lines: [{ price: 10_000n }], deliveredDaysAgo: 1 });
    const r = await req(ua, o, "changed_mind");
    expect(await errCode(w.returns.getForShopper(ub, r.id))).toBe("not_found");
    expect(await errCode(req(ub, o, "changed_mind"))).toBe("not_found");
    expect(await errCode(w.returns.cancel(ub, r.id))).toBe("not_found");
    expect(await errCode(w.returns.openDispute(ub, r.id, { reasonCode: "other" }))).toBe("not_found");
    expect((await w.returns.getForShopper(ua, r.id)).id).toBe(r.id);
  });
  it("seller A cannot inspect, receive or list seller B's returns; wrong role is forbidden", async () => {
    const [a, b] = w.stores;
    const u = await w.newUser();
    const o = await w.order({ userId: u, storeId: b, lines: [{ price: 10_000n }], deliveredDaysAgo: 1 });
    const r = await req(u, o, "changed_mind");
    const sellerA = w.seller(a);
    expect(await errCode(w.returns.receive(sellerA, b, r.id))).toBe("not_found"); // policy: store not in the principal's stores
    expect(await errCode(w.returns.receive(sellerA, a, r.id))).toBe("not_found"); // RLS: row of another store is invisible
    expect(await errCode(w.returns.inspect(sellerA, a, r.id, { result: "accepted" }))).toBe("not_found");
    expect((await w.returns.listForStore(sellerA, a)).some((x) => x.id === r.id)).toBe(false);
    expect((await w.returns.listForStore(w.seller(b), b)).some((x) => x.id === r.id)).toBe(true);
    expect(await errCode(w.returns.inspect(w.seller(b, ["catalog"]), b, r.id, { result: "accepted" }))).toBe("forbidden");
  });
  it("RLS audit passes with the new tables and worker policies, and the whole ledger still balances", async () => {
    await assertTenantTablesProtected(w.raw);
    expect((await Ledger.trialBalance(w.raw, "EG", "EGP")).amountMinor).toBe(0n);
    expect(money(0n, "EGP").amountMinor).toBe(0n);
    expect(DAY).toBe(86_400_000);
  });
});
