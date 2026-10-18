import { describe, expect, it } from "vitest";
import type { LegTransition, RefundLegRecord, RefundRecord, RefundStore } from "../domain/ports";
import { SHOPPER_A, SHOPPER_B, STORE_A, SELLER_ORDER_1, T0, U } from "./fixtures";

/** Intake the way the use case does: the capacity token is read from the store just before. */
export async function intakeNow(
  store: RefundStore,
  input: { consumer: string; messageId: string; refund: RefundRecord },
): Promise<Awaited<ReturnType<RefundStore["intake"]>>> {
  const c = await store.committedForSellerOrder(input.refund.sellerOrderId);
  return store.intake({ ...input, expectedCommitted: c.count });
}

export interface RefundStoreWorld {
  readonly store: RefundStore;
  readonly ensureUser: (id: string) => Promise<void>;
  readonly eventTypes: () => Promise<string[]>;
  /** Outbox payloads of one event type, in order. */
  readonly payloadsOf: (type: string) => Promise<Record<string, unknown>[]>;
}

export function makeRefund(n: number, over: Partial<RefundRecord> = {}, legs?: RefundLegRecord[]): RefundRecord {
  const id = U(0x9000 + n);
  const amount = 10_000n;
  const defaultLeg: RefundLegRecord = {
    id: U(0xa000 + n),
    refundId: id,
    position: 0,
    tenderId: "t1",
    method: "card",
    channel: "psp_original",
    amount,
    creditSub: null,
    tender: { psp: "paymob" },
    state: "REQUESTED",
    attempts: 0,
    nextAttemptAtMs: null,
    providerRef: null,
    failureCode: null,
    needsPayoutDetails: false,
    verify: null,
    note: null,
  };
  return {
    id,
    userId: SHOPPER_A,
    storeId: STORE_A,
    sellerOrderId: SELLER_ORDER_1,
    returnId: U(0xb000 + n),
    source: "return",
    idempotencyKey: `refund-intent:${U(0xb000 + n)}`,
    status: "REQUESTED",
    amount,
    itemTotal: amount,
    voucherTotal: 0n,
    deliveryFeeTotal: 0n,
    lines: [{ orderLineId: "line-1", qty: 1, itemAmount: amount, voucherShare: 0n, deliveryFeeShare: 0n, netAmount: amount }],
    entry: {
      id: U(0xc000 + n),
      requires: [],
      kind: "refund_issued",
      idempotencyKey: `refund:${id}`,
      occurredAtMs: T0,
      ref: { type: "refund", id },
      postings: [
        { account: "seller_payable:s", amount: 10_000n },
        { account: "psp_clearing:paymob", amount: -10_000n },
      ],
    },
    ledgerPostedAtMs: null,
    returnReceivedAtMs: T0,
    requestedAtMs: T0 + n,
    initiatedAtMs: null,
    completedAtMs: null,
    legs: legs ?? [defaultLeg],
    version: 0,
    ...over,
  };
}

const transition = (leg: RefundLegRecord, to: LegTransition["to"], from: LegTransition["from"], nowMs = T0 + 1000): LegTransition => ({
  legId: leg.id,
  from,
  to,
  attempts: 1,
  nextAttemptAtMs: null,
  failureCode: null,
  nowMs,
});

export function describeRefundStoreContract(name: string, make: () => Promise<RefundStoreWorld>): void {
  describe(`RefundStore contract: ${name}`, () => {
    it("intake is idempotent on message id and on the refund's idempotency key", async () => {
      const w = await make();
      await w.ensureUser(SHOPPER_A);
      const r = makeRefund(1);
      expect(await intakeNow(w.store, { consumer: "c", messageId: U(1), refund: r })).toBe("created");
      expect(await intakeNow(w.store, { consumer: "c", messageId: U(1), refund: r })).toBe("duplicate");
      const other = makeRefund(2, { idempotencyKey: r.idempotencyKey });
      expect(await intakeNow(w.store, { consumer: "c", messageId: U(2), refund: other })).toBe("exists");
      expect(await w.store.get(other.id)).toBeNull();
      expect((await w.store.get(r.id))?.legs).toHaveLength(1);
      expect((await w.eventTypes()).filter((t) => t === "refund.requested")).toHaveLength(1);
    });

    it("a different consumer has its own inbox", async () => {
      const w = await make();
      await w.ensureUser(SHOPPER_A);
      await intakeNow(w.store, { consumer: "c1", messageId: U(1), refund: makeRefund(1) });
      expect(await w.store.reject({ consumer: "c1", messageId: U(1), returnId: U(5), reason: "x" })).toBe("duplicate");
      expect(await w.store.reject({ consumer: "c2", messageId: U(1), returnId: U(5), reason: "x" })).toBe("recorded");
    });

    it("markLedgerPosted moves REQUESTED legs once and sets APPROVED", async () => {
      const w = await make();
      await w.ensureUser(SHOPPER_A);
      const r = makeRefund(1);
      await intakeNow(w.store, { consumer: "c", messageId: U(1), refund: r });
      await w.store.markLedgerPosted(r.id, T0 + 5);
      await w.store.markLedgerPosted(r.id, T0 + 9);
      const got = await w.store.get(r.id);
      expect(got?.status).toBe("APPROVED");
      expect(got?.legs[0]?.state).toBe("LEDGER_POSTED");
      expect(got?.ledgerPostedAtMs).toBe(T0 + 5);
      expect(got?.initiatedAtMs).toBe(T0 + 5);
      expect((await w.eventTypes()).filter((t) => t === "refund.approved")).toHaveLength(1);
    });

    it("committedForSellerOrder sums lines and tenders; intake is stale when the token is old", async () => {
      const w = await make();
      await w.ensureUser(SHOPPER_A);
      const empty = await w.store.committedForSellerOrder(SELLER_ORDER_1);
      expect(empty.count).toBe(0);
      expect(await w.store.intake({ consumer: "c", messageId: U(1), refund: makeRefund(1), expectedCommitted: 0 })).toBe("created");
      // A second intent that read the old token must not be created.
      expect(await w.store.intake({ consumer: "c", messageId: U(2), refund: makeRefund(2), expectedCommitted: 0 })).toBe("stale");
      const c = await w.store.committedForSellerOrder(SELLER_ORDER_1);
      expect(c.count).toBe(1);
      expect(c.byLine.get("line-1")).toBe(10_000n);
      expect(c.byTender.get("t1")).toBe(10_000n);
      expect(c.idempotencyKeys.has(makeRefund(1).idempotencyKey)).toBe(true);
      // A stale intake leaves no inbox row: the retry with a fresh token is created.
      expect(await w.store.intake({ consumer: "c", messageId: U(2), refund: makeRefund(2), expectedCommitted: 1 })).toBe("created");
    });

    it("findByProviderRef is scoped by provider", async () => {
      const w = await make();
      await w.ensureUser(SHOPPER_A);
      const r = makeRefund(1);
      const leg = r.legs[0] as RefundLegRecord;
      await intakeNow(w.store, { consumer: "c", messageId: U(1), refund: r });
      await w.store.markLedgerPosted(r.id, T0);
      await w.store.transitionLeg({ ...transition(leg, "SUBMITTED", "LEDGER_POSTED"), providerRef: "same-ref" });
      expect(await w.store.findByProviderRef("valu", "same-ref")).toBeNull();
      expect((await w.store.findByProviderRef("paymob", "same-ref"))?.refundId).toBe(r.id);
    });

    it("transitionLeg applies once, is stale on a wrong `from`, and completes the refund", async () => {
      const w = await make();
      await w.ensureUser(SHOPPER_A);
      const r = makeRefund(1);
      const leg = r.legs[0] as RefundLegRecord;
      await intakeNow(w.store, { consumer: "c", messageId: U(1), refund: r });
      await w.store.markLedgerPosted(r.id, T0);
      const submit = { ...transition(leg, "SUBMITTED", "LEDGER_POSTED"), providerRef: "ref-1" };
      expect(await w.store.transitionLeg(submit)).toBe("applied");
      expect(await w.store.transitionLeg(submit)).toBe("stale");
      expect((await w.store.findByProviderRef("paymob", "ref-1"))?.refundId).toBe(r.id);
      expect((await w.store.get(r.id))?.status).toBe("PROCESSING");
      expect(await w.store.transitionLeg(transition(leg, "COMPLETED", "SUBMITTED", T0 + 2000))).toBe("applied");
      const done = await w.store.get(r.id);
      expect(done?.status).toBe("COMPLETED");
      expect(done?.completedAtMs).toBe(T0 + 2000);
      expect(done?.legs[0]?.providerRef).toBe("ref-1");
      expect((await w.eventTypes()).filter((t) => t === "refund.completed")).toHaveLength(1);
    });

    it("completion emits one order_line.refunded per line with the cumulative goods refunded, once", async () => {
      const w = await make();
      await w.ensureUser(SHOPPER_A);
      const complete = async (n: number, lines: RefundRecord["lines"], amount: bigint): Promise<RefundRecord> => {
        const base = makeRefund(n);
        const leg = { ...(base.legs[0] as RefundLegRecord), amount };
        const r: RefundRecord = { ...base, amount, itemTotal: amount, lines, legs: [leg] };
        await intakeNow(w.store, { consumer: "c", messageId: U(n), refund: r });
        await w.store.markLedgerPosted(r.id, T0);
        await w.store.transitionLeg(transition(leg, "SUBMITTED", "LEDGER_POSTED"));
        expect(await w.store.transitionLeg(transition(leg, "COMPLETED", "SUBMITTED", T0 + 5))).toBe("applied");
        return r;
      };
      const line = (id: string, item: bigint) => ({
        orderLineId: id,
        qty: 1,
        itemAmount: item,
        lineGross: 10_000n,
        voucherShare: 0n,
        deliveryFeeShare: 0n,
        netAmount: item,
      });
      const first = await complete(1, [line("line-1", 3_000n), line("line-2", 1_000n)], 4_000n);
      let ev = await w.payloadsOf("order_line.refunded");
      expect(ev).toHaveLength(2);
      expect(ev[0]).toMatchObject({
        refund_id: first.id,
        seller_order_id: SELLER_ORDER_1,
        user_id: SHOPPER_A,
        order_line_id: "line-1",
        line_merchandise_gross: "10000",
        refunded_merchandise_gross: "3000",
        delta: "3000",
        currency: "EGP",
      });
      // a second refund of the same line: the cumulative moves up, never the delta alone
      await complete(2, [line("line-1", 2_000n)], 2_000n);
      ev = await w.payloadsOf("order_line.refunded");
      expect(ev).toHaveLength(3);
      expect(ev[2]).toMatchObject({ order_line_id: "line-1", refunded_merchandise_gross: "5000", delta: "2000" });
      // re-applying a leg transition that already happened (stale) writes no second event
      const types = await w.eventTypes();
      expect(types.filter((t) => t === "refund.completed")).toHaveLength(2);
      expect(types.filter((t) => t === "order_line.refunded")).toHaveLength(3);
    });

    it("two legs: the refund completes only when both do", async () => {
      const w = await make();
      await w.ensureUser(SHOPPER_A);
      const base = makeRefund(1);
      const l0 = { ...(base.legs[0] as RefundLegRecord), amount: 6_000n };
      const l1: RefundLegRecord = {
        ...l0,
        id: U(0xa100),
        position: 1,
        tenderId: "t2",
        method: "cod",
        channel: "store_credit",
        creditSub: { kind: "refund_credit" },
        amount: 4_000n,
      };
      await intakeNow(w.store, { consumer: "c", messageId: U(1), refund: { ...base, legs: [l0, l1] } });
      await w.store.markLedgerPosted(base.id, T0);
      await w.store.transitionLeg(transition(l1, "COMPLETED", "LEDGER_POSTED"));
      expect((await w.store.get(base.id))?.status).toBe("APPROVED");
      await w.store.transitionLeg(transition(l0, "SUBMITTED", "LEDGER_POSTED"));
      await w.store.transitionLeg(transition(l0, "COMPLETED", "SUBMITTED"));
      expect((await w.store.get(base.id))?.status).toBe("COMPLETED");
    });

    it("lists a user's refunds newest first with a cursor, and never another user's", async () => {
      const w = await make();
      await w.ensureUser(SHOPPER_A);
      await w.ensureUser(SHOPPER_B);
      for (const n of [1, 2, 3]) await intakeNow(w.store, { consumer: "c", messageId: U(n), refund: makeRefund(n) });
      await intakeNow(w.store, { consumer: "c", messageId: U(9), refund: makeRefund(9, { userId: SHOPPER_B }) });
      const first = await w.store.listForUser(SHOPPER_A, { after: null, limit: 2 });
      expect(first.map((r) => r.id)).toEqual([U(0x9003), U(0x9002)]);
      const last = first[1];
      const rest = await w.store.listForUser(SHOPPER_A, {
        after: { createdAtMs: last?.requestedAtMs ?? 0, id: last?.id ?? "" },
        limit: 5,
      });
      expect(rest.map((r) => r.id)).toEqual([U(0x9001)]);
    });

    it("listActionable reports unposted refunds, posted legs and due retries only", async () => {
      const w = await make();
      await w.ensureUser(SHOPPER_A);
      const a = makeRefund(1);
      const b = makeRefund(2);
      await intakeNow(w.store, { consumer: "c", messageId: U(1), refund: a });
      await intakeNow(w.store, { consumer: "c", messageId: U(2), refund: b });
      expect(new Set(await w.store.listActionable(T0, 10))).toEqual(new Set([a.id, b.id]));
      await w.store.markLedgerPosted(b.id, T0);
      const leg = b.legs[0] as RefundLegRecord;
      await w.store.transitionLeg(transition(leg, "SUBMITTED", "LEDGER_POSTED"));
      expect(await w.store.listActionable(T0, 10)).toEqual([a.id]);
      await w.store.transitionLeg({ ...transition(leg, "FAILED", "SUBMITTED"), nextAttemptAtMs: T0 + 60_000, failureCode: "timeout" });
      expect(await w.store.listActionable(T0, 10)).toEqual([a.id]);
      expect(new Set(await w.store.listActionable(T0 + 60_000, 10))).toEqual(new Set([a.id, b.id]));
    });
  });
}
