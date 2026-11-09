/**
 * OrderCancellation end to end on PGlite: real placement, webhook, ledger, reservations, vouchers; refunds through @outlet/returns
 * RefundService.createForCancellation (via CancellationRefundConsumer) and RefundService.process; stock through ReleaseRequiredConsumer.
 */
import { randomUUID } from "node:crypto";
import { createAdminAccess } from "@outlet/admin-access";
import { uuidv7 } from "@outlet/ids";
import { ReleaseRequiredConsumer } from "@outlet/inventory";
import { Ledger, accountCode } from "@outlet/ledger";
import { money } from "@outlet/money";
import { PgOrderFacts, VoucherService } from "@outlet/promotions";
import { FakeAudit, FakeKill as PromoKill } from "@outlet/promotions/testing";
import { RefundService } from "@outlet/returns";
import { FakeEvidence, FakeKill, FakePolicy, FakeProvider, FakeRestock } from "@outlet/returns/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CancellationRefundConsumer, INVENTORY_RELEASE_REQUIRED_EVENT, PROMOTIONS_SETTLE_ATTENTION_EVENT, REFUND_ATTENTION_EVENT, ORDER_GROUP_CANCELLED_EVENT, OrderCancellation, PgStoreCredit, SELLER_ORDER_CANCELLED_EVENT, makePromotionsPort,
} from "../src/index.js";
import type { CancellationAuditEntry, CancellationAuditPort, PaymentMethod, PromotionsPort, VoucherSettlementPort } from "../src/index.js";
import { buildWorld, errCode, intentOf, paidWebhook, quoteAndPlace } from "./fixtures.js";
import type { Sku, World } from "./fixtures.js";

let w: World;
let audit: { entries: CancellationAuditEntry[]; failNext: boolean; seenStatus: (string | undefined)[] } & CancellationAuditPort;
let rprov: FakeProvider;
let refunds: RefundService;
let consumer: CancellationRefundConsumer;
let vouchers: VoucherService;
let promotions: PromotionsPort;
let cancel: OrderCancellation;
const promoKill = new PromoKill();
const KEY = new Uint8Array(32).fill(7);

const acct = (type: Parameters<typeof accountCode>[0]["type"], owner?: string): string => accountCode({ type, market: "EG", currency: "EGP", ...(owner === undefined ? {} : { owner }) });
const bal = async (code: string): Promise<bigint> => (await w.raw.transaction((tx) => Ledger.balance(tx, code))).amountMinor;
const trial = async (): Promise<bigint> => (await w.raw.transaction((tx) => Ledger.trialBalance(tx, "EG", "EGP"))).amountMinor;
const events = async (type: string, groupId: string) =>
  (await w.raw.query<{ id: string; event_type: string; payload: Record<string, unknown> }>(
    "SELECT id, event_type, payload FROM outbox_events WHERE event_type = $1 AND (payload->>'order_group_id') = $2 ORDER BY occurred_at, id", [type, groupId],
  )).rows;
const statusOf = async (groupId: string) => ({
  group: (await w.raw.query<{ status: string; cancel_reason: string | null }>("SELECT status, cancel_reason FROM order_groups WHERE id = $1", [groupId])).rows[0],
  sellers: (await w.raw.query<{ id: string; store_id: string; status: string }>("SELECT id, store_id, status FROM seller_orders WHERE order_group_id = $1 ORDER BY store_id", [groupId])).rows,
});
const refundRows = async (groupId: string) =>
  (await w.raw.query<{ id: string; status: string; reason: string; route: string; amount_minor: string; seller_order_id: string }>(
    "SELECT id, status, reason, route, amount_minor::text, seller_order_id FROM refunds WHERE order_group_id = $1 ORDER BY seller_order_id", [groupId],
  )).rows;

/** Delivers every seller_order.cancelled event of the group to the refund consumer, then processes the APPROVED refunds (finance.refunds worker). */
const settleRefunds = async (groupId: string): Promise<void> => {
  for (const e of await events(SELLER_ORDER_CANCELLED_EVENT, groupId)) await consumer.handle({ id: e.id, type: e.event_type, payload: e.payload });
  for (const r of await refundRows(groupId)) if (r.status === "APPROVED") await refunds.process(r.id);
};

const SNAP = (stores: readonly string[]): string[] => [
  ...stores.map((s) => acct("seller_pending", s)), acct("commission_revenue"), acct("platform_vat_output"), acct("shipping_revenue"), acct("promo_expense_platform"), acct("psp_clearing", "paymob"),
];
const snapshot = async (codes: readonly string[]): Promise<Map<string, bigint>> => new Map(await Promise.all(codes.map(async (c) => [c, await bal(c)] as const)));

const placePaid = async (userId: string, items: readonly { sku: Sku; qty: number }[], method: PaymentMethod = "card", opts: { withPromotions?: boolean } = {}) => {
  await w.fillBag(userId, items);
  const svc = opts.withPromotions === true ? w.makeSvc({}, { promotions }) : w.svc;
  const q = await svc.quote(userId, { addressRef: "01900000-0000-7000-8000-0000000000ad", method });
  const placed = await svc.place(userId, { addressRef: "01900000-0000-7000-8000-0000000000ad", method, idempotencyKey: uuidv7(), quoteToken: q.token, quote: q.quote });
  if (method !== "cod" && method !== "store_credit") {
    const workers = opts.withPromotions === true ? w.makeWorkers({ promotions }) : { webhooks: w.webhooks };
    await workers.webhooks.handle(paidWebhook(w, await intentOf(w, placed.orderGroupId), randomUUID()));
  }
  return placed.orderGroupId;
};

beforeAll(async () => {
  w = await buildWorld();
  const entries: CancellationAuditEntry[] = [];
  const seenStatus: (string | undefined)[] = [];
  // Records the group status as seen THROUGH the caller's transaction (proves the append runs inside it, before commit); can fail on demand.
  audit = {
    entries, failNext: false, seenStatus,
    appendIn: async (tx, e) => {
      seenStatus.push((await tx.query<{ status: string }>("SELECT status FROM order_groups WHERE id = $1", [e.targetId])).rows[0]?.status);
      if (audit.failNext) { audit.failNext = false; throw new Error("audit down"); }
      entries.push(e);
    },
  };
  rprov = new FakeProvider();
  const admin = createAdminAccess({ db: w.app, audit: { appendIn: () => Promise.resolve() }, clock: w.now, thresholdMinor: 50_000_000n });
  refunds = new RefundService({
    admin, app: w.app, worker: w.workerClient, marketId: "EG", policy: new FakePolicy(), evidence: new FakeEvidence(), restock: new FakeRestock(), provider: rprov, kill: new FakeKill(), now: w.now,
    config: { dualApproval: { thresholdMinor: 50_000_000n } },
  });
  consumer = new CancellationRefundConsumer(w.workerClient, "EG", refunds, { now: w.now });
  const pdeps = { client: w.app, marketId: "EG", kill: promoKill, audit: new FakeAudit(), hmacKey: KEY, now: w.now, velocityPerHour: 1000, orderFacts: PgOrderFacts.forWorker(w.workerClient, "EG") };
  promotions = makePromotionsPort(pdeps);
  vouchers = new VoucherService(pdeps);
  cancel = new OrderCancellation({ client: w.app, marketId: "EG", reservations: w.reservations, provider: w.fakes.provider, credit: new PgStoreCredit("EGP"), audit, vouchers, now: w.now });
});
afterAll(async () => { await w.close(); });
beforeEach(async () => {
  promoKill.enabled = true;
  w.fakes.risk.decision = "allow";
  w.fakes.provider.nextVoid = "voided";
  w.fakes.address.codEligible = true;
  await w.raw.query("UPDATE promotions SET status = 'ENDED'");
});

describe("OrderCancellation: paid card order, whole group", () => {
  it("reverses the ledger exactly, refunds through the router, releases stock, reinstates the voucher and notifies", async () => {
    const [sa, sb] = [w.stores[0], w.stores[1]];
    const skuA = await w.seedSku(sa, 100_000n, 5);
    const skuB = await w.seedSku(sb, 50_000n, 5);
    // a platform-funded voucher: the case a return would leave in seller_pending, the cancellation must reverse
    const promoId = randomUUID();
    await w.raw.query(
      `INSERT INTO promotions (id, market_id, owner_type, store_id, type, name_ar, rules, stacking_class, funding_platform_bp, funding_seller_bp, currency, starts_at, ends_at, status, version)
       VALUES ($1,'EG','platform',NULL,'fixed','عرض',$2::jsonb,'auto',10000,0,'EGP','2029-12-01T00:00:00Z','2031-01-01T00:00:00Z','ACTIVE',1)`,
      [promoId, JSON.stringify({ level: "order", discount: { kind: "fixed", amountMinor: "10000" } })],
    );
    await w.raw.query("INSERT INTO promotion_usage (promotion_id, store_id, market_id, currency) VALUES ($1,NULL,'EG','EGP')", [promoId]);
    const codes = SNAP([sa, sb]);
    const before = await snapshot(codes);
    const u = await w.newUser();
    const g = await placePaid(u, [{ sku: skuA, qty: 1 }, { sku: skuB, qty: 2 }], "card", { withPromotions: true });
    expect(await bal(acct("promo_expense_platform"))).toBeGreaterThan(before.get(acct("promo_expense_platform")) ?? 0n);
    expect([await w.free(skuA), await w.free(skuB)]).toEqual([4, 3]);
    const total = BigInt((await w.raw.query<{ t: string }>("SELECT total_minor::text AS t FROM order_groups WHERE id = $1", [g])).rows[0]?.t ?? "0");

    const res = await cancel.execute({ userId: u, orderGroupId: g, reasonCode: "changed_mind", refundPreference: undefined });
    expect(res).toMatchObject({ groupStatus: "CANCELLED", scope: "full", refundExpected: true, vouchers: "reinstated", replayed: false });
    expect(res.cancelledSellerOrderIds).toHaveLength(2);
    const st = await statusOf(g);
    expect(st.group).toEqual({ status: "CANCELLED", cancel_reason: "changed_mind" });
    expect(st.sellers.map((s) => s.status)).toEqual(["CANCELLED", "CANCELLED"]);
    const lines = await w.raw.query<{ status: string }>("SELECT DISTINCT status FROM order_lines WHERE order_group_id = $1", [g]);
    expect(lines.rows.map((r) => r.status)).toEqual(["cancelled"]);

    // notifications event carries the recipient; one seller_order.cancelled and one inventory.release_required per store
    const og = await events(ORDER_GROUP_CANCELLED_EVENT, g);
    expect(og).toHaveLength(1);
    expect(og[0]?.payload).toMatchObject({ user_id: u, scope: "full", reason_code: "changed_mind", initiator: "shopper", refund_expected: true });
    expect(await events(SELLER_ORDER_CANCELLED_EVENT, g)).toHaveLength(2);
    const rel = await events(INVENTORY_RELEASE_REQUIRED_EVENT, g);
    expect(rel).toHaveLength(2);
    const inventory = new ReleaseRequiredConsumer({ client: w.app, marketId: "EG", now: w.now });
    for (const e of rel) expect(await inventory.handle({ id: e.id, payload: e.payload })).toBe("processed");
    expect([await w.free(skuA), await w.free(skuB)]).toEqual([5, 5]);

    // voucher came back (refund-then-reuse rule: whole group, before shipping)
    const kinds = (await w.raw.query<{ kind: string }>("SELECT kind FROM voucher_redemptions WHERE order_group_id = $1 ORDER BY kind", [g])).rows.map((r) => r.kind);
    expect(kinds).toContain("reinstated");

    // refunds: one per store, through the RefundRouter to the card (psp_original), summing to what the shopper paid
    const calls0 = rprov.calls.length;
    await settleRefunds(g);
    const rr = await refundRows(g);
    expect(rr.map((r) => [r.reason, r.route, r.status])).toEqual([["cancellation", "psp_original", "COMPLETED"], ["cancellation", "psp_original", "COMPLETED"]]);
    expect(rr.reduce((a, r) => a + BigInt(r.amount_minor), 0n)).toBe(total);
    expect(rprov.calls.slice(calls0).reduce((a, c) => a + c.amount.amountMinor, 0n)).toBe(total);

    // ledger: every account the order touched is back where it was (order_recognised negated by refund + cancel_adjust), trial balance 0
    expect(await snapshot(codes)).toEqual(before);
    expect(await trial()).toBe(0n);
    expect(audit.entries.at(-1)).toMatchObject({ action: "order.cancel", actorType: "user", actorId: u, targetId: g });
  });
});

describe("OrderCancellation: partial, shipped, replay, preference", () => {
  it("cancels one unshipped store among two; the shipped one stays; a whole-group cancel is then 409 cancel-after-shipping", async () => {
    const [sa, sb] = [w.stores[0], w.stores[1]];
    const skuA = await w.seedSku(sa, 40_000n, 5);
    const skuB = await w.seedSku(sb, 30_000n, 5);
    const u = await w.newUser();
    const g = await placePaid(u, [{ sku: skuA, qty: 1 }, { sku: skuB, qty: 1 }]);
    const st0 = await statusOf(g);
    const soA = st0.sellers.find((s) => s.store_id === sa)?.id ?? "";
    const soB = st0.sellers.find((s) => s.store_id === sb)?.id ?? "";
    await w.raw.query("UPDATE seller_orders SET status = 'SHIPPED' WHERE id = $1", [soB]);
    const sellerB = await bal(acct("seller_pending", sb));

    const res = await cancel.execute({ userId: u, orderGroupId: g, reasonCode: "ordered_by_mistake", sellerOrderIds: [soA] });
    expect(res).toMatchObject({ scope: "partial", groupStatus: "PAID", cancelledSellerOrderIds: [soA], vouchers: "none" });
    expect((await statusOf(g)).sellers.map((s) => [s.id === soA ? "A" : "B", s.status]).sort()).toEqual([["A", "CANCELLED"], ["B", "SHIPPED"]]);
    expect(await errCode(cancel.execute({ userId: u, orderGroupId: g, reasonCode: "ordered_by_mistake" }))).toBe("cancel-after-shipping");
    expect(await errCode(cancel.execute({ userId: u, orderGroupId: g, reasonCode: "ordered_by_mistake", sellerOrderIds: [soB] }))).toBe("cancel-after-shipping");

    await settleRefunds(g);
    const rr = await refundRows(g);
    expect(rr.map((r) => r.seller_order_id)).toEqual([soA]);
    expect(await bal(acct("seller_pending", sa))).toBe(0n);
    expect(await bal(acct("seller_pending", sb))).toBe(sellerB);
    expect(await trial()).toBe(0n);
    // the same partial request replays (idempotent by group + reason), a different reason does not
    expect(await cancel.execute({ userId: u, orderGroupId: g, reasonCode: "ordered_by_mistake", sellerOrderIds: [soA] })).toMatchObject({ replayed: true, cancelledSellerOrderIds: [] });
    expect(await errCode(cancel.execute({ userId: u, orderGroupId: g, reasonCode: "other", sellerOrderIds: [soA] }))).toBe("order-not-cancellable");
  });

  it("is idempotent: a repeat replays without new events; the consumer replays the same refund; another shopper's group is not found", async () => {
    const sku = await w.seedSku(w.stores[2], 20_000n, 5);
    const u = await w.newUser();
    const g = await placePaid(u, [{ sku, qty: 1 }]);
    await cancel.cancel({ userId: u, orderGroupId: g, reasonCode: "other", refundPreference: "store_credit" });
    const n = (await w.raw.query<{ n: number }>("SELECT count(*)::int AS n FROM outbox_events WHERE (payload->>'order_group_id') = $1", [g])).rows[0]?.n;
    expect(await cancel.execute({ userId: u, orderGroupId: g, reasonCode: "other" })).toMatchObject({ replayed: true, groupStatus: "CANCELLED" });
    expect((await w.raw.query<{ n: number }>("SELECT count(*)::int AS n FROM outbox_events WHERE (payload->>'order_group_id') = $1", [g])).rows[0]?.n).toBe(n);
    expect(await errCode(cancel.execute({ userId: u, orderGroupId: g, reasonCode: "changed_mind" }))).toBe("order-not-cancellable");
    const ev = (await events(SELLER_ORDER_CANCELLED_EVENT, g))[0];
    if (ev === undefined) throw new Error("no event");
    expect(await consumer.handle({ id: ev.id, type: ev.event_type, payload: ev.payload })).toBe("processed");
    expect(await consumer.handle({ id: ev.id, type: ev.event_type, payload: ev.payload })).toBe("duplicate");
    const again = await refunds.createForCancellation({ userId: u, orderGroupId: g, reason: "cancellation" });
    expect(again.map((r) => r.replayed)).toEqual([true]);
    // shopper chose instant store credit for a card payment: the router sends it to refund_credit
    expect((await refundRows(g)).map((r) => r.route)).toEqual(["store_credit"]);
    const other = await w.newUser();
    expect(await errCode(cancel.execute({ userId: other, orderGroupId: g, reasonCode: "other" }))).toBe("not-found");
    await expect(refunds.createForCancellation({ userId: other, orderGroupId: g, reason: "cancellation" })).rejects.toThrow();
  });

  it("refuses an instant store-credit choice on a BNPL order (provider only, 422)", async () => {
    const sku = await w.seedSku(w.stores[0], 20_000n, 5);
    const u = await w.newUser();
    const g = await placePaid(u, [{ sku, qty: 1 }], "card");
    await w.raw.query("UPDATE order_groups SET payment_method = 'bnpl' WHERE id = $1", [g]);
    expect(await errCode(cancel.execute({ userId: u, orderGroupId: g, reasonCode: "other", refundPreference: "store_credit" }))).toBe("refund-preference-invalid");
  });

  it("seller-initiated cancel of one paid seller order; another store's id is not found", async () => {
    const sku = await w.seedSku(w.stores[1], 25_000n, 5);
    const u = await w.newUser();
    const g = await placePaid(u, [{ sku, qty: 1 }]);
    const so = (await statusOf(g)).sellers[0]?.id ?? "";
    await w.raw.query("UPDATE seller_orders SET status = 'ACCEPTED' WHERE id = $1", [so]);
    expect(await errCode(cancel.cancelBySeller({ storeId: w.stores[0], actorId: "m1", sellerOrderId: so, reasonCode: "out_of_stock" }))).toBe("not-found");
    const res = await cancel.cancelBySeller({ storeId: w.stores[1], actorId: "m1", sellerOrderId: so, reasonCode: "out_of_stock" });
    expect(res).toMatchObject({ groupStatus: "CANCELLED", scope: "full" });
    expect((await events(SELLER_ORDER_CANCELLED_EVENT, g))[0]?.payload).toMatchObject({ initiator: "seller", reason_code: "out_of_stock" });
    expect(audit.entries.at(-1)).toMatchObject({ actorType: "store_member", actorId: "m1" });
    await settleRefunds(g);
    expect((await refundRows(g)).map((r) => r.status)).toEqual(["COMPLETED"]);
    expect(await trial()).toBe(0n);
  });
});

describe("OrderCancellation: PACKED order with an AWB (M4)", () => {
  it("emits shipment.cancel_required only for a live outbound shipment of a PACKED order", async () => {
    const sku = await w.seedSku(w.stores[1], 25_000n, 5);
    const u = await w.newUser();
    const g = await placePaid(u, [{ sku, qty: 1 }]);
    const so = (await statusOf(g)).sellers[0]?.id ?? "";
    await w.raw.query("UPDATE seller_orders SET status = 'PACKED' WHERE id = $1", [so]);
    const ship = async (status: string, direction = "outbound"): Promise<string> => {
      const id = randomUUID();
      await w.raw.query(
        `INSERT INTO shipments (id, market_id, store_id, user_id, seller_order_ids, direction, courier, service_level, awb, status, declared_weight_g, idempotency_key)
         VALUES ($1,'EG',$2,$3,$4,$5,'fake','standard',$8,$6,500,$7)`, [id, w.stores[1], u, [so], direction, status, `k:${id}`, `AWB-${id}`]);
      return id;
    };
    const live = await ship("LABEL_READY");
    await ship("CANCELLED");
    await ship("DELIVERED", "return");
    await cancel.cancelBySeller({ storeId: w.stores[1], actorId: "m1", sellerOrderId: so, reasonCode: "cannot_fulfil" });
    const ev = (await w.raw.query<{ payload: { shipment_id: string; seller_order_id: string } }>("SELECT payload FROM outbox_events WHERE event_type = 'shipment.cancel_required' AND payload->>'order_group_id' = $1", [g])).rows;
    expect(ev.map((e) => e.payload)).toMatchObject([{ shipment_id: live, seller_order_id: so }]);
  });
});

describe("OrderCancellation: unpaid and cash on delivery", () => {
  it("COD awaiting confirmation: group cancelled, seller orders voided, reservation released, no refund row", async () => {
    w.fakes.risk.decision = "require_confirmation";
    const sku = await w.seedSku(w.stores[0], 30_000n, 3);
    const u = await w.newUser();
    await w.fillBag(u, [{ sku, qty: 2 }]);
    const { place } = await quoteAndPlace(w, u, "cod");
    const g = (await place()).orderGroupId;
    expect((await statusOf(g)).group?.status).toBe("AWAITING_COD_CONFIRMATION");
    expect(await w.free(sku)).toBe(3); // reserved, not claimed: on_hand - committed unchanged
    const voids = w.fakes.provider.voidCalls.length;
    const res = await cancel.execute({ userId: u, orderGroupId: g, reasonCode: "changed_mind" });
    expect(res).toMatchObject({ groupStatus: "CANCELLED", refundExpected: false });
    expect(w.fakes.provider.voidCalls.length).toBe(voids); // no PSP intent for COD
    expect((await statusOf(g)).sellers.map((s) => s.status)).toEqual(["VOIDED"]);
    const resv = await w.raw.query<{ state: string }>("SELECT r.state FROM reservations r JOIN order_groups g ON g.reservation_id = r.id WHERE g.id = $1", [g]);
    expect(resv.rows[0]?.state).toBe("RELEASED");
    expect(await events(INVENTORY_RELEASE_REQUIRED_EVENT, g)).toHaveLength(0);
    await settleRefunds(g);
    expect(await refunds.createForCancellation({ userId: u, orderGroupId: g, reason: "cancellation" })).toEqual([]);
    expect(await refundRows(g)).toEqual([]);
  });

  it("COD confirmed (claimed, nothing charged): stock release event, no refund", async () => {
    const sku = await w.seedSku(w.stores[1], 30_000n, 3);
    const u = await w.newUser();
    await w.fillBag(u, [{ sku, qty: 1 }]);
    const { place } = await quoteAndPlace(w, u, "cod");
    const g = (await place()).orderGroupId;
    expect((await statusOf(g)).group?.status).toBe("CONFIRMED_COD");
    expect(await cancel.execute({ userId: u, orderGroupId: g, reasonCode: "other" })).toMatchObject({ groupStatus: "CANCELLED", refundExpected: false });
    expect(await events(INVENTORY_RELEASE_REQUIRED_EVENT, g)).toHaveLength(1);
    await settleRefunds(g);
    expect(await refundRows(g)).toEqual([]);
  });

  it("unpaid card + store credit: the PSP intent is voided first, the credit hold is released; a capture in flight is 409", async () => {
    const sku = await w.seedSku(w.stores[2], 30_000n, 3);
    const u = await w.newUser();
    await w.grantCredit(u, 10_000n);
    await w.fillBag(u, [{ sku, qty: 1 }]);
    const { place } = await quoteAndPlace(w, u, "card", { creditRequested: money(10_000n, "EGP") });
    const g = (await place()).orderGroupId;
    const held = async (): Promise<string[]> => (await w.raw.query<{ status: string }>("SELECT status FROM ledger_holds WHERE ref_id = $1", [g])).rows.map((r) => r.status);
    expect(await held()).toEqual(["HELD"]);
    w.fakes.provider.nextVoid = "already_captured";
    expect(await errCode(cancel.execute({ userId: u, orderGroupId: g, reasonCode: "other" }))).toBe("payment-in-flight");
    expect((await statusOf(g)).group?.status).toBe("PENDING_PAYMENT");
    w.fakes.provider.nextVoid = "voided";
    expect(await cancel.execute({ userId: u, orderGroupId: g, reasonCode: "other" })).toMatchObject({ groupStatus: "CANCELLED", refundExpected: false });
    expect(w.fakes.provider.voidCalls.at(-1)?.key).toBe(`cancel:${g}`);
    expect(await held()).toEqual(["RELEASED"]);
    expect((await w.raw.query<{ status: string }>("SELECT status FROM payment_intents WHERE order_group_id = $1", [g])).rows[0]?.status).toBe("CANCELLED");
  });

  it("store-credit-only paid order: the refund goes back to the same sub-balance (ledger), balance restored", async () => {
    const sku = await w.seedSku(w.stores[0], 15_000n, 3);
    const u = await w.newUser();
    await w.grantCredit(u, 100_000n);
    const code = accountCode({ type: "store_credit", market: "EG", currency: "EGP", owner: u, sub: "goodwill" });
    const start = await bal(code);
    await w.fillBag(u, [{ sku, qty: 1 }]);
    const q = await w.svc.quote(u, { addressRef: "01900000-0000-7000-8000-0000000000ad", method: "store_credit", creditRequested: money(100_000n, "EGP") });
    const g = (await w.svc.place(u, { addressRef: "01900000-0000-7000-8000-0000000000ad", method: "store_credit", idempotencyKey: uuidv7(), quoteToken: q.token, quote: q.quote, creditRequested: q.quote.total })).orderGroupId;
    expect(await bal(code)).toBeGreaterThan(start); // liability (credit-normal, negative) shrank in magnitude
    await cancel.execute({ userId: u, orderGroupId: g, reasonCode: "changed_mind" });
    await settleRefunds(g);
    expect((await refundRows(g)).map((r) => [r.route, r.status])).toEqual([["store_credit", "COMPLETED"]]);
    expect(await bal(code)).toBe(start);
    expect(await trial()).toBe(0n);
  });

  it("an expired or refunded group is not cancellable", async () => {
    const sku = await w.seedSku(w.stores[0], 15_000n, 3);
    const u = await w.newUser();
    const g = await placePaid(u, [{ sku, qty: 1 }]);
    await w.raw.query("UPDATE order_groups SET status = 'COMPLETED' WHERE id = $1", [g]);
    expect(await errCode(cancel.execute({ userId: u, orderGroupId: g, reasonCode: "other" }))).toBe("order-not-cancellable");
    await expect(cancel.execute({ userId: u, orderGroupId: g, reasonCode: "nope" })).rejects.toThrow();
  });
});

const addPlatformPromo = async (amountMinor: string): Promise<string> => {
  const id = randomUUID();
  await w.raw.query(
    `INSERT INTO promotions (id, market_id, owner_type, store_id, type, name_ar, rules, stacking_class, funding_platform_bp, funding_seller_bp, currency, starts_at, ends_at, status, version)
     VALUES ($1,'EG','platform',NULL,'fixed','عرض',$2::jsonb,'auto',10000,0,'EGP','2029-12-01T00:00:00Z','2031-01-01T00:00:00Z','ACTIVE',1)`,
    [id, JSON.stringify({ level: "order", discount: { kind: "fixed", amountMinor } })],
  );
  await w.raw.query("INSERT INTO promotion_usage (promotion_id, store_id, market_id, currency) VALUES ($1,NULL,'EG','EGP')", [id]);
  return id;
};

describe("chief review fixes", () => {
  it("H1: a PSP capture after an unpaid group was cancelled is owed back (REFUND_PENDING, late_refund entry), never re-claimed", async () => {
    const sku = await w.seedSku(w.stores[0], 30_000n, 3);
    const u = await w.newUser();
    await w.fillBag(u, [{ sku, qty: 1 }]);
    const { place } = await quoteAndPlace(w, u, "card");
    const g = (await place()).orderGroupId;
    const intent = await intentOf(w, g);
    await cancel.execute({ userId: u, orderGroupId: g, reasonCode: "changed_mind" });
    const out = await w.webhooks.handle(paidWebhook(w, intent, randomUUID()));
    expect(out).toMatchObject({ outcome: "processed", detail: "late_refund" });
    expect((await statusOf(g)).group?.status).toBe("REFUND_PENDING");
    expect((await w.raw.query("SELECT 1 FROM journal_entries WHERE idempotency_key = $1", [`late_refund:${g}`])).rows).toHaveLength(1);
    expect((await w.raw.query("SELECT 1 FROM outbox_events WHERE event_type = 'order_group.late_payment_refund' AND aggregate_id = $1", [g])).rows).toHaveLength(1);
    expect(await w.free(sku)).toBe(3); // stock not re-claimed
    expect(await trial()).toBe(0n);
  });

  it("H1: voidIntent not_found on an intent the PSP already acted on fails closed (409 payment-in-flight)", async () => {
    const sku = await w.seedSku(w.stores[1], 30_000n, 3);
    const u = await w.newUser();
    await w.fillBag(u, [{ sku, qty: 1 }]);
    const { place } = await quoteAndPlace(w, u, "card");
    const g = (await place()).orderGroupId;
    expect((await intentOf(w, g)).status).toBe("REQUIRES_ACTION");
    w.fakes.provider.nextVoid = "not_found";
    expect(await errCode(cancel.execute({ userId: u, orderGroupId: g, reasonCode: "other" }))).toBe("payment-in-flight");
    expect((await statusOf(g)).group?.status).toBe("PENDING_PAYMENT");
  });

  it("M1: a permanent refusal (mutated seller-order snapshot) parks the event with refund.attention instead of redelivering; no refund row", async () => {
    const sku = await w.seedSku(w.stores[2], 20_000n, 3);
    const u = await w.newUser();
    const g = await placePaid(u, [{ sku, qty: 1 }]);
    await cancel.execute({ userId: u, orderGroupId: g, reasonCode: "other" });
    const so = (await statusOf(g)).sellers[0]?.id ?? "";
    await w.raw.query("UPDATE seller_orders SET seller_net_minor = seller_net_minor + 1 WHERE id = $1", [so]);
    const ev = (await events(SELLER_ORDER_CANCELLED_EVENT, g))[0];
    if (ev === undefined) throw new Error("no event");
    expect(await consumer.handle({ id: ev.id, type: ev.event_type, payload: ev.payload })).toBe("processed");
    expect(await consumer.handle({ id: ev.id, type: ev.event_type, payload: ev.payload })).toBe("duplicate");
    const att = await events(REFUND_ATTENTION_EVENT, g);
    expect(att).toHaveLength(1);
    expect(att[0]?.payload).toMatchObject({ order_group_id: g, seller_order_id: so, error: "refund_exceeds_paid" });
    expect(await refundRows(g)).toEqual([]);
    // malformed payload: also permanent
    expect(await consumer.handle({ id: uuidv7(), type: SELLER_ORDER_CANCELLED_EVENT, payload: { order_group_id: "x" } })).toBe("processed");
    // infrastructure failure keeps throwing (no inbox row, redelivered)
    const boom = new CancellationRefundConsumer(w.workerClient, "EG", { createForCancellation: () => Promise.reject(new Error("db down")) });
    const id = uuidv7();
    await expect(boom.handle({ id, type: SELLER_ORDER_CANCELLED_EVENT, payload: ev.payload })).rejects.toThrow("db down");
    expect((await w.raw.query("SELECT 1 FROM inbox_processed WHERE message_id = $1", [id])).rows).toHaveLength(0);
    await w.raw.query("UPDATE seller_orders SET seller_net_minor = seller_net_minor - 1 WHERE id = $1", [so]);
  });

  it("M5: the audit record is appended inside the cancel transaction; an audit failure rolls the whole cancel back", async () => {
    const sku = await w.seedSku(w.stores[0], 30_000n, 3);
    const u = await w.newUser();
    const g = await placePaid(u, [{ sku, qty: 1 }]);
    audit.failNext = true;
    await expect(cancel.execute({ userId: u, orderGroupId: g, reasonCode: "changed_mind" })).rejects.toThrow("audit down");
    expect(audit.seenStatus.at(-1)).toBe("CANCELLED"); // the append saw the uncommitted change
    expect((await statusOf(g)).group?.status).toBe("PAID"); // ...and its failure rolled it back
    expect(await events(ORDER_GROUP_CANCELLED_EVENT, g)).toHaveLength(0);
    const n = audit.entries.length;
    await cancel.execute({ userId: u, orderGroupId: g, reasonCode: "changed_mind" });
    expect(audit.entries).toHaveLength(n + 1);
    expect(audit.entries.at(-1)).toMatchObject({ actorType: "user", actorId: u, targetId: g, diff: { after: { status: "CANCELLED", replayed: false } } });
  });

  it("H (finding 1): a failed voucher settlement is logged at error level and parked as promotions.settle_attention", async () => {
    await addPlatformPromo("4000");
    const sku = await w.seedSku(w.stores[0], 50_000n, 3);
    const u = await w.newUser();
    const g = await placePaid(u, [{ sku, qty: 1 }], "card", { withPromotions: true });
    const logged: { msg: string; fields: Record<string, unknown> | undefined }[] = [];
    const broken: VoucherSettlementPort = { release: () => Promise.reject(new Error("x")), reinstate: () => Promise.reject(Object.assign(new Error("nope"), { code: "REINSTATE_NOT_ALLOWED" })) };
    const c3 = new OrderCancellation({ client: w.app, marketId: "EG", reservations: w.reservations, provider: w.fakes.provider, credit: new PgStoreCredit("EGP"), audit, vouchers: broken, now: w.now, log: { error: (msg, fields) => { logged.push({ msg, fields }); } } });
    expect(await c3.execute({ userId: u, orderGroupId: g, reasonCode: "changed_mind" })).toMatchObject({ vouchers: "failed", groupStatus: "CANCELLED" });
    expect(logged).toEqual([{ msg: "cancellation voucher settlement failed", fields: { order_group_id: g, action: "reinstate", error: "REINSTATE_NOT_ALLOWED" } }]);
    const parked = await events(PROMOTIONS_SETTLE_ATTENTION_EVENT, g);
    expect(parked.map((e) => e.payload)).toEqual([{ order_group_id: g, action: "reinstate", error: "REINSTATE_NOT_ALLOWED" }]);
    // the default promotions port (no explicit orderFacts) reinstates on the replay: the shopper-scoped facts see the cancelled group
    const defaults = new OrderCancellation({ client: w.app, marketId: "EG", reservations: w.reservations, provider: w.fakes.provider, credit: new PgStoreCredit("EGP"), audit, vouchers: makePromotionsPort({ client: w.app, marketId: "EG", kill: promoKill, now: w.now }), now: w.now });
    expect(await defaults.execute({ userId: u, orderGroupId: g, reasonCode: "changed_mind" })).toMatchObject({ vouchers: "reinstated", replayed: true });
  });

  it("H (finding 1): default stderr log; a non-Error rejection reads 'unknown'; an attention write failure is logged, never thrown", async () => {
    const { OutboxWriter, pgTransactionalWriter } = await import("@outlet/outbox");
    await addPlatformPromo("2000");
    const sku = await w.seedSku(w.stores[0], 30_000n, 3);
    const u = await w.newUser();
    const g = await placePaid(u, [{ sku, qty: 1 }], "card", { withPromotions: true });
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the port contract cannot stop a non-Error rejection
    const broken: VoucherSettlementPort = { release: () => Promise.reject(new Error("x")), reinstate: () => Promise.reject("string failure") };
    // the attention insert fails (its own transaction), every other event goes through
    const picky = new OutboxWriter({ insertEvent: (tx, e) => (e.type === PROMOTIONS_SETTLE_ATTENTION_EVENT ? Promise.reject(new TypeError("outbox down")) : pgTransactionalWriter.insertEvent(tx, e)) });
    const lines: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => { lines.push(String(chunk)); return true; });
    try {
      const c4 = new OrderCancellation({ client: w.app, marketId: "EG", reservations: w.reservations, provider: w.fakes.provider, credit: new PgStoreCredit("EGP"), audit, vouchers: broken, outbox: picky, now: w.now });
      expect(await c4.execute({ userId: u, orderGroupId: g, reasonCode: "changed_mind" })).toMatchObject({ vouchers: "failed", groupStatus: "CANCELLED" });
    } finally {
      process.stderr.write = write;
    }
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed).toEqual([
      { level: "error", msg: "cancellation voucher settlement failed", order_group_id: g, action: "reinstate", error: "unknown" },
      { level: "error", msg: "promotions.settle_attention could not be written", order_group_id: g, action: "reinstate", error: "TypeError" },
    ]);
    expect(await events(PROMOTIONS_SETTLE_ATTENTION_EVENT, g)).toHaveLength(0);
  });

  it("finding 2: cancelled before the settle consumer confirmed; reinstate releases the reservation and a late confirm is a no-op", async () => {
    await addPlatformPromo("3000");
    const sku = await w.seedSku(w.stores[0], 40_000n, 3);
    const u = await w.newUser();
    const g = await placePaid(u, [{ sku, qty: 1 }], "card", { withPromotions: true });
    const kinds = async (): Promise<string[]> => (await w.raw.query<{ kind: string }>("SELECT kind FROM voucher_redemptions WHERE order_group_id = $1 ORDER BY kind", [g])).rows.map((r) => r.kind);
    // placePaid confirms synchronously in this harness; rewind to "settle event not consumed yet" by dropping the confirmation row
    await w.raw.query("ALTER TABLE voucher_redemptions DISABLE TRIGGER USER");
    await w.raw.query("DELETE FROM voucher_redemptions WHERE order_group_id = $1 AND kind = 'confirmed'", [g]);
    await w.raw.query("ALTER TABLE voucher_redemptions ENABLE TRIGGER USER");
    expect(await kinds()).toEqual(["reserved"]);
    expect(await cancel.execute({ userId: u, orderGroupId: g, reasonCode: "changed_mind" })).toMatchObject({ vouchers: "reinstated", groupStatus: "CANCELLED" });
    expect(await kinds()).toEqual(["released", "reserved"]);
    expect(await promotions.confirm(u, g)).toBe(0);
    expect(await kinds()).toEqual(["released", "reserved"]);
  });

  it("M3: a failed voucher reinstate is retried by replaying the same cancel", async () => {
    await addPlatformPromo("5000");
    const sku = await w.seedSku(w.stores[0], 60_000n, 3);
    const u = await w.newUser();
    const g = await placePaid(u, [{ sku, qty: 1 }], "card", { withPromotions: true });
    let fail = true;
    const flaky: VoucherSettlementPort = {
      release: (a, b) => vouchers.release(a, b),
      reinstate: (a, b) => (fail ? Promise.reject(new Error("promotions down")) : vouchers.reinstate(a, b)),
    };
    const c2 = new OrderCancellation({ client: w.app, marketId: "EG", reservations: w.reservations, provider: w.fakes.provider, credit: new PgStoreCredit("EGP"), audit, vouchers: flaky, now: w.now, log: { error: () => undefined } });
    expect(await c2.execute({ userId: u, orderGroupId: g, reasonCode: "other" })).toMatchObject({ vouchers: "failed", replayed: false });
    const kinds = async (): Promise<string[]> => (await w.raw.query<{ kind: string }>("SELECT kind FROM voucher_redemptions WHERE order_group_id = $1 ORDER BY kind", [g])).rows.map((r) => r.kind);
    expect(await kinds()).not.toContain("reinstated");
    fail = false;
    expect(await c2.execute({ userId: u, orderGroupId: g, reasonCode: "other" })).toMatchObject({ vouchers: "reinstated", replayed: true });
    expect(await kinds()).toContain("reinstated");
    expect(await c2.execute({ userId: u, orderGroupId: g, reasonCode: "other" })).toMatchObject({ vouchers: "reinstated", replayed: true }); // idempotent
    expect((await kinds()).filter((k) => k === "reinstated")).toHaveLength(1);
  });
});
