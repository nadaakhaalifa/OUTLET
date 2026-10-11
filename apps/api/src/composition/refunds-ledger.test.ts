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
import { ORDER_GROUP_1, SELLER_ORDER_1, SeqIds, STORE_A, TestClock, facts, intent, tender } from "./refunds-fixtures";
import { buildEntry, chart, money } from "./domain";
import { LedgerGateway } from "./ledger-gateway";
import { Late } from "./late";

/**
 * Composition-level guard (F-2): refunds run against the REAL PostingService and the in-memory
 * ledger store, through the same LedgerGateway that production wiring uses, so a fake ledger can
 * never again hide an entry the posting service refuses.
 */
async function realWorld() {
  const { sha256Hex } = await import("@outlet/idempotency");
  const clock = new TestClock();
  const mem = new InMemoryLedger();
  const ids = createIdGenerator(clock, nodeCsprng);
  const posting = new PostingService<LedgerTxn>({
    store: mem as never,
    clock,
    ids,
    sha256: sha256Hex,
    flags: { giftCardSalesEnabled: () => true },
  });
  const lates = {
    posting: new Late<PostingService<LedgerTxn>>("posting"),
    store: new Late<never>("store"),
    reads: new Late<never>("reads"),
  };
  lates.posting.bind(posting);
  lates.store.bind(mem as never);
  lates.reads.bind(mem as never);
  const gateway = new LedgerGateway({
    posting: lates.posting,
    store: lates.store,
    reads: lates.reads,
    uow: { run: (fn) => mem.run(fn) },
  });
  const store = new InMemoryRefundStore();
  const factsPort = new FakeRefundFacts();
  const credit = new FakeCreditRestore();
  const executor = new FakeRefundExecutor();
  const refundIds = new SeqIds(0x70000);
  const intake = new IntakeRefundIntent(store, factsPort, refundIds, clock);
  const process = new ProcessRefund(store, gateway.refunds(), credit, executor, new FakePayoutDetails(), clock, new SeqJitter(0));
  const recognise = async (): Promise<void> => {
    const entry = buildEntry(
      {
        type: "order_paid",
        orderGroupId: ORDER_GROUP_1,
        storeOrders: [{ storeId: STORE_A, merchandise: money(10_000n), commissionBps: 1_000n }],
        shippingGross: money(0n),
        vatBps: 1_400n,
        external: { kind: "psp", psp: "paymob" },
      },
      { id: ids.uuidV7(), occurredAt: new Date(clock.nowMs()) },
    );
    await mem.run((tx) => posting.post(tx, entry));
  };
  return { mem, store, factsPort, credit, executor, intake, process, recognise };
}

describe("refunds against the real posting service", () => {
  it("intake -> process posts the refund entry with a uuid id, once, and the ledger balances", async () => {
    const w = await realWorld();
    await w.recognise();
    w.factsPort.seed(SELLER_ORDER_1, facts([tender("t1", "card", 10_000n)]));
    const created = await w.intake.execute(intent(1, { net: 10_000n }));
    expect(created.kind).toBe("created");
    const refundId = created.kind === "created" ? created.refundId : "";
    const r = await w.process.execute(refundId);
    expect(r?.ledger).toBe("posted");
    expect(r?.status).toBe("COMPLETED");
    const stored = await w.store.get(refundId);
    const posted = w.mem.entries.find((e) => e.entry.idempotencyKey === `refund:${refundId}:${STORE_A}`);
    expect(posted?.entry.id).toBe(stored?.entry.id);
    // Replay: the same key returns the same entry, nothing new is appended.
    const before = w.mem.entries.length;
    await w.process.execute(refundId);
    expect(w.mem.entries.length).toBe(before);
    // Value left the PSP clearing account and the seller's payable was unwound.
    const sums = new Map<string, bigint>();
    for (const e of w.mem.entries) for (const p of e.entry.postings) sums.set(p.account, (sums.get(p.account) ?? 0n) + p.amount.amount);
    expect(sums.get(chart.pspClearing("paymob"))).toBe(0n);
    expect([...sums.values()].reduce((a, b) => a + b, 0n)).toBe(0n);
  });

  it("without the order's recognition entry the real gateway reports it missing and nothing is posted", async () => {
    const w = await realWorld();
    w.factsPort.seed(SELLER_ORDER_1, facts([tender("t1", "card", 10_000n)]));
    const created = await w.intake.execute(intent(1, { net: 10_000n }));
    const refundId = created.kind === "created" ? created.refundId : "";
    await expect(w.process.execute(refundId)).rejects.toBeInstanceOf(RefundRecognitionMissingError);
    expect(w.mem.entries).toHaveLength(0);
    await w.recognise();
    expect((await w.process.execute(refundId))?.status).toBe("COMPLETED");
  });

  it("BNPL stays provider-only through the real ledger: the entry credits bnpl_clearing, never store credit", async () => {
    const w = await realWorld();
    await w.recognise();
    w.factsPort.seed(SELLER_ORDER_1, facts([tender("t1", "bnpl", 10_000n)]));
    const created = await w.intake.execute(intent(1, { net: 10_000n, preference: "store_credit" }));
    const refundId = created.kind === "created" ? created.refundId : "";
    await w.process.execute(refundId);
    const refund = await w.store.get(refundId);
    expect(refund?.legs.map((l) => l.channel)).toEqual(["bnpl_cancel"]);
    const posted = w.mem.entries.find((e) => e.entry.idempotencyKey === `refund:${refundId}:${STORE_A}`);
    expect(posted?.entry.postings.some((p) => p.account === chart.bnplClearing("valu"))).toBe(true);
    expect(posted?.entry.postings.some((p) => p.account.startsWith("store_credit"))).toBe(false);
  });
});
