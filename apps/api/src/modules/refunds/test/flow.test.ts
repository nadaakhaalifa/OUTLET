import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MAX_REFUND_ATTEMPTS, money } from "../domain/bridge";
import {
  FakeCreditRestore,
  FakePayoutDetails,
  FakeRefundExecutor,
  FakeRefundFacts,
  InMemoryRefundLedger,
  SeqJitter,
} from "../adapters/fakes";
import { InMemoryRefundStore } from "../adapters/in-memory";
import { IntakeRefundIntent, RefundFactsUnavailableError, RefundIntakeConflictError } from "../application/intake";
import { RefundRecognitionMissingError } from "../application/errors";
import { ProcessRefund, SweepRefunds } from "../application/process";
import { ConfirmProviderOutcome, ResolveManualReview } from "../application/provider";
import { GetMyRefund } from "../application/queries";
import { ORDER_GROUP_1, SELLER_ORDER_1, SHOPPER_A, SHOPPER_B, SeqIds, TestClock, facts, intent, tender } from "./fixtures";

function world() {
  const clock = new TestClock();
  const ids = new SeqIds();
  const store = new InMemoryRefundStore();
  const factsPort = new FakeRefundFacts();
  const ledger = new InMemoryRefundLedger();
  ledger.recognise(ORDER_GROUP_1);
  const credit = new FakeCreditRestore();
  const executor = new FakeRefundExecutor();
  const payout = new FakePayoutDetails();
  const jitter = new SeqJitter(0);
  const intake = new IntakeRefundIntent(store, factsPort, ids, clock);
  const process = new ProcessRefund(store, ledger, credit, executor, payout, clock, jitter);
  return { clock, store, factsPort, ledger, credit, executor, payout, intake, process, ids };
}

async function create(w: ReturnType<typeof world>, n = 1, over: Parameters<typeof intent>[1] = {}): Promise<string> {
  const r = await w.intake.execute(intent(n, over));
  if (r.kind !== "created") throw new Error(`expected created, got ${r.kind}`);
  return r.refundId;
}

describe("refund intake (inbox, idempotent)", () => {
  it("creates once for a replayed message id and once for a republished return", async () => {
    const w = world();
    w.factsPort.seed(SELLER_ORDER_1, facts([tender("t1", "card", 10_000n)]));
    const first = await w.intake.execute(intent(1));
    expect(first.kind).toBe("created");
    expect((await w.intake.execute(intent(1))).kind).toBe("duplicate");
    const republished = intent(1) as { messageId: string };
    const again = await w.intake.execute({ ...republished, messageId: "00000000-0000-4000-8000-0000000099ff" });
    expect(again.kind).toBe("exists");
    expect(w.store.events.filter((e) => e.type === "refund.requested")).toHaveLength(1);
  });

  it("retries (throws) while payment facts are not available, and never marks the message processed", async () => {
    const w = world();
    await expect(w.intake.execute(intent(1))).rejects.toBeInstanceOf(RefundFactsUnavailableError);
    w.factsPort.seed(SELLER_ORDER_1, facts([tender("t1", "card", 10_000n)]));
    expect((await w.intake.execute(intent(1))).kind).toBe("created");
  });

  it("rejects an intent whose owner disagrees with the payment facts, with a recorded event", async () => {
    const w = world();
    w.factsPort.seed(SELLER_ORDER_1, facts([tender("t1", "card", 10_000n)]));
    const r = await w.intake.execute(intent(1, { userId: SHOPPER_B }));
    expect(r).toEqual({ kind: "rejected", reason: "owner_mismatch" });
    expect(w.store.events.map((e) => e.type)).toContain("refund.intent_rejected");
  });

  it("rejects malformed messages by throwing (schema at the boundary)", async () => {
    const w = world();
    await expect(w.intake.execute({ messageId: "x" })).rejects.toThrow();
  });
});

describe("refund processing", () => {
  it("card: ledger first, then one provider call keyed by the leg id, then COMPLETED", async () => {
    const w = world();
    w.factsPort.seed(SELLER_ORDER_1, facts([tender("t1", "card", 10_000n)]));
    const id = await create(w);
    const r = await w.process.execute(id);
    expect(r).toMatchObject({ status: "COMPLETED", ledger: "posted" });
    const refund = await w.store.get(id);
    expect(w.executor.calls).toHaveLength(1);
    expect(w.executor.calls[0]).toMatchObject({ channel: "psp_original", idempotencyKey: refund?.legs[0]?.id });
    expect(w.ledger.entries.size).toBe(1);
    // replay is a no-op: same ledger entry, no second provider call
    expect(await w.process.execute(id)).toMatchObject({ status: "COMPLETED", ledger: "already" });
    expect(w.executor.calls).toHaveLength(1);
    expect(w.store.events.map((e) => e.type)).toEqual([
      "refund.requested",
      "refund.approved",
      "refund.completed",
      "order_line.refunded", // additive producer for creators clawback; money effects above are unchanged
    ]);
    expect(w.store.events.find((e) => e.type === "order_line.refunded")).toMatchObject({
      orderLineId: "line-1",
      lineGross: 10_000n,
      refundedGross: 10_000n,
      delta: 10_000n,
    });
  });

  it("BNPL with a stated store-credit preference is still cancelled at the provider only", async () => {
    const w = world();
    w.factsPort.seed(SELLER_ORDER_1, facts([tender("t1", "bnpl", 10_000n)]));
    const id = await create(w, 1, { preference: "store_credit" });
    await w.process.execute(id);
    const refund = await w.store.get(id);
    expect(refund?.legs.map((l) => l.channel)).toEqual(["bnpl_cancel"]);
    expect(refund?.legs[0]?.note).toBe("preference_ignored_bnpl_provider_only");
    expect(w.executor.calls.map((c) => c.channel)).toEqual(["bnpl_cancel"]);
    expect(w.credit.restored.size).toBe(0);
  });

  it("COD defaults to instant HAUL credit with no provider call", async () => {
    const w = world();
    w.factsPort.seed(SELLER_ORDER_1, facts([tender("t1", "cod", 10_000n)]));
    const id = await create(w);
    await w.process.execute(id);
    expect((await w.store.get(id))?.status).toBe("COMPLETED");
    expect(w.executor.calls).toHaveLength(0);
    expect([...w.credit.restored.values()]).toMatchObject([{ userId: SHOPPER_A, sub: "refund_credit", amount: 10_000n }]);
  });

  it("COD bank transfer waits for verified payout details without failing", async () => {
    const w = world();
    w.factsPort.seed(SELLER_ORDER_1, facts([tender("t1", "cod", 10_000n)], { choice: { cod: "bank_transfer" } }));
    const id = await create(w);
    await w.process.execute(id);
    expect((await w.store.get(id))?.status).toBe("APPROVED");
    expect(w.executor.calls).toHaveLength(0);
    w.payout.verify(SHOPPER_A, "bank_transfer_iban");
    await w.process.execute(id);
    expect((await w.store.get(id))?.status).toBe("COMPLETED");
    expect(w.executor.calls.map((c) => c.channel)).toEqual(["bank_transfer_iban"]);
  });

  it("store-credit tender goes back to the same sub-balance", async () => {
    const w = world();
    w.factsPort.seed(
      SELLER_ORDER_1,
      facts([tender("t1", "gift_card", 10_000n, { creditSub: { kind: "gift_card", cardId: "card-1" } })]),
    );
    const id = await create(w);
    await w.process.execute(id);
    expect([...w.credit.restored.values()]).toMatchObject([{ sub: "gift_card", amount: 10_000n }]);
    expect(w.executor.calls).toHaveLength(0);
  });

  it("a provider timeout retries after backoff with the same idempotency key, then completes", async () => {
    const w = world();
    w.factsPort.seed(SELLER_ORDER_1, facts([tender("t1", "card", 10_000n)]));
    const id = await create(w);
    const legId = (await w.store.get(id))?.legs[0]?.id ?? "";
    w.executor.scriptFor(legId, "throw");
    await w.process.execute(id);
    expect((await w.store.get(id))?.legs[0]?.state).toBe("FAILED");
    await w.process.execute(id); // not due yet
    expect(w.executor.calls).toHaveLength(1);
    w.clock.advance(3_600_000);
    await w.process.execute(id);
    const after = await w.store.get(id);
    expect(after?.status).toBe("COMPLETED");
    expect(w.executor.calls.map((c) => c.idempotencyKey)).toEqual([legId, legId]);
    expect(w.ledger.entries.size).toBe(1);
  });

  it("escalates to MANUAL_REVIEW when attempts are exhausted; finance resolves it", async () => {
    const w = world();
    w.factsPort.seed(SELLER_ORDER_1, facts([tender("t1", "card", 10_000n)]));
    const id = await create(w);
    const legId = (await w.store.get(id))?.legs[0]?.id ?? "";
    w.executor.scriptFor(legId, ...Array<"throw">(MAX_REFUND_ATTEMPTS + 2).fill("throw"));
    for (let i = 0; i < MAX_REFUND_ATTEMPTS + 3; i += 1) {
      await w.process.execute(id);
      w.clock.advance(3_600_000);
    }
    const stuck = await w.store.get(id);
    expect(stuck?.status).toBe("MANUAL_REVIEW");
    expect(w.executor.calls).toHaveLength(MAX_REFUND_ATTEMPTS);
    const resolve = new ResolveManualReview(w.store, w.clock);
    expect(await resolve.execute({ legId, refundId: id, outcome: "transferred" })).toBe("applied");
    expect((await w.store.get(id))?.status).toBe("COMPLETED");
    expect(await resolve.execute({ legId, refundId: id, outcome: "transferred" })).toBe("stale");
  });

  it("recovers from a crash between steps: ledger unavailable, then re-run posts once", async () => {
    const w = world();
    w.factsPort.seed(SELLER_ORDER_1, facts([tender("t1", "card", 10_000n)]));
    const id = await create(w);
    w.ledger.failNext = 1;
    await expect(w.process.execute(id)).rejects.toThrow();
    expect(w.executor.calls).toHaveLength(0);
    await w.process.execute(id);
    expect((await w.store.get(id))?.status).toBe("COMPLETED");
    expect(w.ledger.entries.size).toBe(1);
  });

  it("async provider acceptance completes through the callback, and an unknown ref is ignored", async () => {
    const w = world();
    w.factsPort.seed(SELLER_ORDER_1, facts([tender("t1", "card", 10_000n)]));
    const id = await create(w);
    const legId = (await w.store.get(id))?.legs[0]?.id ?? "";
    w.executor.scriptFor(legId, { kind: "pending", providerRef: "psp-ref-1" });
    await w.process.execute(id);
    expect((await w.store.get(id))?.status).toBe("PROCESSING");
    const cb = new ConfirmProviderOutcome(w.store, w.clock, new SeqJitter(0));
    expect(await cb.execute({ provider: "paymob", providerRef: "nope", result: "confirmed" })).toBe("unknown");
    expect(await cb.execute({ provider: "paymob", providerRef: "psp-ref-1", result: "confirmed" })).toBe("completed");
    expect(await cb.execute({ provider: "paymob", providerRef: "psp-ref-1", result: "confirmed" })).toBe("stale");
    expect((await w.store.get(id))?.status).toBe("COMPLETED");
  });

  it("the sweeper processes due refunds and a second sweep finds nothing", async () => {
    const w = world();
    w.factsPort.seed(SELLER_ORDER_1, facts([tender("t1", "card", 10_000n)]));
    await create(w);
    const sweep = new SweepRefunds(w.store, w.process, w.clock);
    expect(await sweep.execute()).toEqual({ processed: 1 });
    expect(await sweep.execute()).toEqual({ processed: 0 });
  });
});

describe("refund reads (BOLA)", () => {
  it("another shopper's refund looks like a missing one", async () => {
    const w = world();
    w.factsPort.seed(SELLER_ORDER_1, facts([tender("t1", "card", 10_000n)]));
    const id = await create(w);
    const q = new GetMyRefund(w.store, w.clock);
    expect(await q.execute(SHOPPER_B, id)).toBeNull();
    expect((await q.execute(SHOPPER_A, id))?.slo).toBe("on_track");
  });
});

describe("refund properties", () => {
  const methods = fc.constantFrom("card", "apple_pay", "meeza", "mobile_wallet", "instapay", "fawry", "bnpl", "cod", "store_credit", "gift_card" as const);
  it("for any tender mix and choice: legs sum to the refund and the posted entry balances", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(methods, fc.integer({ min: 100, max: 500_000 })), { minLength: 1, maxLength: 4 }),
        fc.constantFrom("original_method", "store_credit" as const),
        fc.integer({ min: 1, max: 100 }),
        async (mix, preference, pct) => {
          const tenders = mix.map(([m, a], i) => tender(`t${i}`, m, BigInt(a)));
          const total = tenders.reduce((s, t) => s + t.amount.amount, 0n);
          const net = (total * BigInt(pct)) / 100n || 1n;
          const w = world();
          w.factsPort.seed(SELLER_ORDER_1, facts(tenders));
          const id = await create(w, 1, { net, preference });
          const refund = await w.store.get(id);
          expect(refund?.legs.reduce((s, l) => s + l.amount, 0n)).toBe(net);
          for (const l of refund?.legs ?? []) {
            // B3: BNPL never reaches credit or cash; and only BNPL reaches bnpl_cancel
            expect(l.method === "bnpl").toBe(l.channel === "bnpl_cancel");
          }
          await w.process.execute(id);
          for (const e of w.ledger.entries.values()) {
            expect(e.postings.reduce((s, p) => s + p.amount.amount, 0n)).toBe(0n);
          }
          const entryCount = w.ledger.entries.size;
          await w.process.execute(id);
          expect(w.ledger.entries.size).toBe(entryCount);
        },
      ),
      { numRuns: 40 },
    );
  });
});

describe("refund capacity (F-5): per line, per seller order, serialised", () => {
  it("a second intent for the same line under another return id is rejected and creates nothing", async () => {
    const w = world();
    w.factsPort.seed(SELLER_ORDER_1, facts([tender("t1", "card", 30_000n)], { lines: [{ orderLineId: "line-1", gross: 10_000n, refundedBefore: 0n }] }));
    expect((await w.intake.execute(intent(1, { net: 10_000n }))).kind).toBe("created");
    // The group tender still has 20,000 left, but the line has nothing left.
    expect(await w.intake.execute(intent(2, { net: 10_000n }))).toEqual({ kind: "rejected", reason: "not_refundable" });
    expect(w.store.events.filter((e) => e.type === "refund.requested")).toHaveLength(1);
  });

  it("multi-store: store A's refunds cannot consume the group's card capacity that belongs to store B", async () => {
    const w = world();
    // Group paid 30,000 by card: store A 10,000 (this seller order), store B 20,000.
    w.factsPort.seed(
      SELLER_ORDER_1,
      facts([tender("card", "card", 30_000n)], { lines: [{ orderLineId: "line-1", gross: 10_000n, refundedBefore: 0n }] }),
    );
    expect((await w.intake.execute(intent(1, { net: 6_000n }))).kind).toBe("created");
    expect((await w.intake.execute(intent(2, { net: 4_000n }))).kind).toBe("created");
    const third = await w.intake.execute(intent(3, { net: 1n }));
    expect(third).toEqual({ kind: "rejected", reason: "not_refundable" });
    const total = [...w.store.events].reduce((a, e) => (e.type === "refund.requested" ? a + e.amount : a), 0n);
    expect(total).toBe(10_000n);
  });

  it("partial refunds on one line add up: the line value is the ceiling", async () => {
    const w = world();
    w.factsPort.seed(SELLER_ORDER_1, facts([tender("t1", "card", 10_000n)]));
    expect((await w.intake.execute(intent(1, { net: 7_000n }))).kind).toBe("created");
    expect((await w.intake.execute(intent(2, { net: 3_001n }))).kind).toBe("rejected");
    expect((await w.intake.execute(intent(3, { net: 3_000n }))).kind).toBe("created");
  });

  it("goods refunded elsewhere (facts) count against the line and the tender", async () => {
    const w = world();
    w.factsPort.seed(
      SELLER_ORDER_1,
      facts([tender("t1", "card", 10_000n, { refundedBefore: money(8_000n) })], {
        lines: [{ orderLineId: "line-1", gross: 10_000n, refundedBefore: 8_000n }],
      }),
    );
    expect((await w.intake.execute(intent(1, { net: 2_001n }))).kind).toBe("rejected");
    expect((await w.intake.execute(intent(2, { net: 2_000n }))).kind).toBe("created");
  });

  it("two concurrent intents: exactly one is created, the other is told to retry and then rejected", async () => {
    const w = world();
    w.factsPort.seed(SELLER_ORDER_1, facts([tender("t1", "card", 10_000n)]));
    const results = await Promise.allSettled([w.intake.execute(intent(1)), w.intake.execute(intent(2))]);
    const created = results.filter((r) => r.status === "fulfilled" && r.value.kind === "created");
    const conflicts = results.filter((r) => r.status === "rejected" && r.reason instanceof RefundIntakeConflictError);
    expect(created).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(await w.intake.execute(intent(2))).toEqual({ kind: "rejected", reason: "not_refundable" });
  });

  it("a voucher on the order: a figure that disagrees with the ledger plan is rejected, never re-allocated", async () => {
    const w = world();
    w.factsPort.seed(
      SELLER_ORDER_1,
      facts([tender("t1", "card", 9_000n)], { platformVoucher: 400n, sellerVoucher: 600n, lines: [{ orderLineId: "line-1", gross: 10_000n, refundedBefore: 0n }] }),
    );
    // The returns module claims 9,000 net for 9,000 of goods; the plan releases 10% of the voucher with them.
    expect(await w.intake.execute(intent(1, { net: 9_000n }))).toEqual({ kind: "rejected", reason: "allocation_mismatch" });
  });
});

describe("refund requires order recognition (F-8)", () => {
  it("fails closed with a typed retryable error until the recognition entry exists, then posts", async () => {
    const w = world();
    const strict = new InMemoryRefundLedger();
    const process = new ProcessRefund(w.store, strict, w.credit, w.executor, w.payout, w.clock, new SeqJitter(0));
    w.factsPort.seed(SELLER_ORDER_1, facts([tender("t1", "card", 10_000n)]));
    const id = await create(w);
    await expect(process.execute(id)).rejects.toBeInstanceOf(RefundRecognitionMissingError);
    expect(strict.entries.size).toBe(0);
    expect((await w.store.get(id))?.ledgerPostedAtMs).toBeNull();
    // The sweeper does not stall on it.
    await expect(new SweepRefunds(w.store, process, w.clock).execute()).resolves.toEqual({ processed: 1 });
    strict.recognise(ORDER_GROUP_1);
    expect((await process.execute(id))?.status).toBe("COMPLETED");
  });

  it("the entry id chosen at intake is a uuid and is the one posted", async () => {
    const w = world();
    w.factsPort.seed(SELLER_ORDER_1, facts([tender("t1", "card", 10_000n)]));
    const id = await create(w);
    const stored = (await w.store.get(id))?.entry;
    expect(stored?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    await w.process.execute(id);
    const posted = [...w.ledger.entries.values()][0];
    expect(posted?.id).toBe(stored?.id);
    expect(posted?.idempotencyKey).toBe(`refund:${id}:${(await w.store.get(id))?.storeId}`);
  });
});

describe("provider callbacks are scoped by provider (F-14)", () => {
  it("the same reference from another provider does not settle the leg", async () => {
    const w = world();
    w.factsPort.seed(SELLER_ORDER_1, facts([tender("t1", "card", 10_000n)]));
    const id = await create(w);
    const legId = (await w.store.get(id))?.legs[0]?.id ?? "";
    w.executor.scriptFor(legId, { kind: "pending", providerRef: "ref-same" });
    await w.process.execute(id);
    const cb = new ConfirmProviderOutcome(w.store, w.clock, new SeqJitter(0));
    expect(await cb.execute({ provider: "other-psp", providerRef: "ref-same", result: "confirmed" })).toBe("unknown");
    expect(await cb.execute({ provider: "paymob", providerRef: "ref-same", result: "confirmed" })).toBe("completed");
  });
});

describe("R-3/R-4: delivery fee is capped by the facts, in-flight refunds count", () => {
  const withFee = (n: number, fee: bigint, net: bigint) => {
    const i = intent(n, { net }) as { event: { allocation: { deliveryFeeTotal: string; netTotal: string; lines: Array<{ netAmount: string; deliveryFeeShare: string }> } } };
    const a = i.event.allocation;
    a.deliveryFeeTotal = fee.toString();
    a.netTotal = (net + fee).toString();
    a.lines[0]!.netAmount = (net + fee).toString();
    a.lines[0]!.deliveryFeeShare = fee.toString();
    return i;
  };
  it("a fee beyond the paid fee, or repeated across partial intents, is rejected", async () => {
    const w = world();
    w.factsPort.seed(SELLER_ORDER_1, facts([tender("t1", "card", 20_000n)], { deliveryFee: 6_000n, lines: [{ orderLineId: "line-1", gross: 14_000n, refundedBefore: 0n }] }));
    expect((await w.intake.execute(withFee(1, 6_000n, 7_000n))).kind).toBe("created");
    // The second partial intent tries to take the full fee again: the in-flight refund counts.
    expect(await w.intake.execute(withFee(2, 6_000n, 7_000n))).toEqual({ kind: "rejected", reason: "allocation_inconsistent" });
    expect((await w.intake.execute(withFee(3, 0n, 7_000n))).kind).toBe("created");
  });
  it("fees already refunded elsewhere (facts) reduce the cap", async () => {
    const w = world();
    w.factsPort.seed(SELLER_ORDER_1, facts([tender("t1", "card", 20_000n)], { deliveryFee: 6_000n, deliveryFeeRefundedBefore: 6_000n, lines: [{ orderLineId: "line-1", gross: 14_000n, refundedBefore: 0n }] }));
    expect(await w.intake.execute(withFee(1, 100n, 7_000n))).toEqual({ kind: "rejected", reason: "allocation_inconsistent" });
  });
  it("in-flight refunds of the same seller order consume tender capacity (R-4)", async () => {
    const w = world();
    w.factsPort.seed(SELLER_ORDER_1, facts([tender("t1", "card", 10_000n)], { lines: [{ orderLineId: "line-1", gross: 20_000n, refundedBefore: 0n }] }));
    expect((await w.intake.execute(intent(1, { net: 7_000n }))).kind).toBe("created");
    expect(await w.intake.execute(intent(2, { net: 7_000n }))).toEqual({ kind: "rejected", reason: "not_refundable" });
  });
});
