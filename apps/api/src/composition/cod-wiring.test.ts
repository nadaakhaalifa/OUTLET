import { describe, expect, it } from "vitest";
import { createIdGenerator, nodeCsprng } from "../platform";
import { InMemoryLedger, PostingService, type LedgerTxn } from "../modules/ledger";
import {
  FakeCreditRestore,
  FakePayoutDetails,
  FakeRefundExecutor,
  FakeRefundFacts,
  InMemoryRefundStore,
  IntakeRefundIntent,
  ProcessRefund,
  RefundRecognitionMissingError,
  SeqJitter,
} from "../modules/refunds";
import { ORDER_GROUP_1, SELLER_ORDER_1, SeqIds, SHOPPER_A, STORE_A, TestClock, facts, intent, tender } from "./refunds-fixtures";
import { chart, checkout, money } from "./domain";
import { LedgerGateway } from "./ledger-gateway";
import { Late } from "./late";
import { CodLedgerRecognition, InMemoryCodCounters, type CodSagaReader } from "./cod-wiring";
import type { BridgedEvent } from "./money-adapters";

const ZERO = money(0n);
const quote: checkout.CheckoutQuote = {
  method: "cod",
  lines: [],
  stores: [
    { storeId: STORE_A, merchandise: money(10_000n), platformFundedDiscount: ZERO, sellerFundedDiscount: ZERO, deliveryFee: ZERO, shipping: ZERO, freeDeliveryReason: "none", vat: ZERO, total: money(10_000n) },
  ],
  subtotal: money(10_000n),
  discount: ZERO,
  shipping: ZERO,
  vat: ZERO,
  total: money(10_000n),
  tender: { storeCredit: [], storeCreditTotal: ZERO, externalDue: money(10_000n) },
  vatBps: 1_400n,
};
const sagas: CodSagaReader = {
  get: async (g) => (g === ORDER_GROUP_1 ? { userId: SHOPPER_A, stored: { quote, commissionBps: { [STORE_A]: 1_000 } } } : null),
};

async function world() {
  const { sha256Hex } = await import("@outlet/idempotency");
  const clock = new TestClock();
  const mem = new InMemoryLedger();
  const ids = createIdGenerator(clock, nodeCsprng);
  const posting = new PostingService<LedgerTxn>({ store: mem as never, clock, ids, sha256: sha256Hex, flags: { giftCardSalesEnabled: () => true } });
  const lates = { posting: new Late<PostingService<LedgerTxn>>("posting"), store: new Late<never>("store"), reads: new Late<never>("reads") };
  lates.posting.bind(posting);
  lates.store.bind(mem as never);
  lates.reads.bind(mem as never);
  const gateway = new LedgerGateway({ posting: lates.posting, store: lates.store, reads: lates.reads, uow: { run: (fn) => mem.run(fn) } });
  const counters = new InMemoryCodCounters();
  const cod = new CodLedgerRecognition({
    ledger: gateway.checkout(),
    sagas,
    groups: { locate: async (id) => (id === SELLER_ORDER_1 ? { orderGroupId: ORDER_GROUP_1, userId: SHOPPER_A, storeId: STORE_A } : null) },
    counters,
  });
  const store = new InMemoryRefundStore();
  const factsPort = new FakeRefundFacts();
  const intake = new IntakeRefundIntent(store, factsPort, new SeqIds(0x70000), clock);
  const process = new ProcessRefund(store, gateway.refunds(), new FakeCreditRestore(), new FakeRefundExecutor(), new FakePayoutDetails(), clock, new SeqJitter(0));
  return { mem, cod, counters, intake, process, store, factsPort };
}

const ev = (id: string, type: string, payload: Record<string, unknown>): BridgedEvent => ({ id, type, occurredAtMs: 1_000, payload });
const delivered = (id = "m1") => ev(id, "shipment.delivered", { seller_order_id: SELLER_ORDER_1, courier: "bosta", cod: true });

describe("COD ledger recognition", () => {
  it("delivered COD recognises under the shared key, then refunds work end to end", async () => {
    const w = await world();
    w.factsPort.seed(SELLER_ORDER_1, facts([tender("t1", "cod", 10_000n)]));
    const created = await w.intake.execute(intent(1, { net: 10_000n }));
    const refundId = created.kind === "created" ? created.refundId : "";
    await expect(w.process.execute(refundId)).rejects.toBeInstanceOf(RefundRecognitionMissingError);
    expect(await w.cod.handle(delivered())).toBe("recognised");
    const key = checkout.orderRecognitionKey(ORDER_GROUP_1, "cod");
    expect(w.mem.entries.some((e) => e.entry.idempotencyKey === key)).toBe(true);
    expect((await w.process.execute(refundId))?.status).toBe("COMPLETED");
    const sums = new Map<string, bigint>();
    for (const e of w.mem.entries) for (const p of e.entry.postings) sums.set(p.account, (sums.get(p.account) ?? 0n) + p.amount.amount);
    expect([...sums.values()].reduce((a, b) => a + b, 0n)).toBe(0n);
  });

  it("replaying the delivered event (and a sibling delivery) posts once", async () => {
    const w = await world();
    expect(await w.cod.handle(delivered("m1"))).toBe("recognised");
    expect(await w.cod.handle(delivered("m1"))).toBe("duplicate");
    expect(await w.cod.handle(delivered("m2"))).toBe("duplicate");
    expect(w.mem.entries).toHaveLength(1);
  });

  it("RTO posts nothing and reverses the COD counter once", async () => {
    const w = await world();
    const rto = (id: string, type: string) => ev(id, type, { seller_order_id: SELLER_ORDER_1, courier: "bosta", cod: true });
    expect(await w.cod.handle(rto("r1", "shipment.rto_initiated"))).toBe("reversed");
    expect(await w.cod.handle(rto("r2", "shipment.rto_received"))).toBe("duplicate");
    expect(w.mem.entries).toHaveLength(0);
    expect([...w.counters.reversals.values()]).toEqual([{ userId: SHOPPER_A, orderGroupId: ORDER_GROUP_1, amount: 10_000n }]);
  });

  it("prepaid shipments are ignored", async () => {
    const w = await world();
    expect(await w.cod.handle(ev("p1", "shipment.delivered", { seller_order_id: SELLER_ORDER_1, courier: "bosta", cod: false }))).toBe("skipped");
    expect(w.mem.entries).toHaveLength(0);
  });

  it("matched remittance posts cod_collected once and clears cod_clearing", async () => {
    const w = await world();
    await w.cod.handle(delivered());
    const rem = ev("x1", "cod_remittance.matched", { courier: "bosta", courier_ref: "R1", matched_amount: "10000", matched_fee: "500" });
    expect(await w.cod.handle(rem)).toBe("recognised");
    expect(await w.cod.handle(rem)).toBe("duplicate");
    const sums = new Map<string, bigint>();
    for (const e of w.mem.entries) for (const p of e.entry.postings) sums.set(p.account, (sums.get(p.account) ?? 0n) + p.amount.amount);
    expect(sums.get(chart.codClearing("bosta"))).toBe(0n);
    expect(await w.cod.handle(ev("x2", "cod_remittance.mismatch", { courier: "bosta", courier_ref: "R2", matched_amount: "0", matched_fee: "0" }))).toBe("skipped");
  });
});
