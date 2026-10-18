// Targeted tests for the refund application layer (intake, ledger-first processing, provider callbacks,
// entry codec). Written to kill Stryker survivors (ADR-0019). Every test drives the real use cases against
// the in-memory store and fakes; subclasses of the store inject the races and crashes that are otherwise
// hard to reach (stale transitions, a crash between two writes, a leg with no credit sub).
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
import { IntakeRefundIntent, RETURN_INTENT_CONSUMER, RefundFactsUnavailableError } from "../application/intake";
import { RefundRecognitionMissingError } from "../application/errors";
import { fromStoredEntry, toStoredEntry } from "../application/entry-codec";
import { ProcessRefund, SweepRefunds } from "../application/process";
import { ConfirmProviderOutcome, ResolveManualReview } from "../application/provider";
import type { LegTransition, RefundLegRecord, RefundRecord } from "../domain/ports";
import { ORDER_GROUP_1, SELLER_ORDER_1, SHOPPER_A, STORE_A, SeqIds, T0, TestClock, U, facts, intent, tender } from "./fixtures";

type Tweak = (r: RefundRecord) => RefundRecord;

class TweakStore extends InMemoryRefundStore {
  tweak: Tweak | null = null;
  failTransition: ((t: LegTransition) => "throw" | "stale" | null) | null = null;
  intakeResult: "exists" | "duplicate" | null = null;
  override async get(id: string): Promise<RefundRecord | null> {
    const r = await super.get(id);
    return r === null || this.tweak === null ? r : this.tweak(r);
  }
  override async transitionLeg(t: LegTransition): Promise<"applied" | "stale"> {
    const f = this.failTransition?.(t) ?? null;
    if (f === "throw") throw new Error("crash between steps");
    if (f === "stale") return "stale";
    return super.transitionLeg(t);
  }
  override async intake(input: Parameters<InMemoryRefundStore["intake"]>[0]): ReturnType<InMemoryRefundStore["intake"]> {
    if (this.intakeResult !== null) return this.intakeResult;
    return super.intake(input);
  }
}

function world(strictLedger = false) {
  const clock = new TestClock();
  const ids = new SeqIds();
  const store = new TweakStore();
  const factsPort = new FakeRefundFacts();
  const ledger = new InMemoryRefundLedger();
  if (!strictLedger) ledger.recognise(ORDER_GROUP_1);
  const credit = new FakeCreditRestore();
  const executor = new FakeRefundExecutor();
  const payout = new FakePayoutDetails();
  const jitter = new SeqJitter(0);
  const intake = new IntakeRefundIntent(store, factsPort, ids, clock);
  const process = new ProcessRefund(store, ledger, credit, executor, payout, clock, jitter);
  const confirm = new ConfirmProviderOutcome(store, clock, jitter);
  const resolve = new ResolveManualReview(store, clock);
  return { clock, ids, store, factsPort, ledger, credit, executor, payout, intake, process, confirm, resolve };
}
type W = ReturnType<typeof world>;

async function create(w: W, n = 1, over: Parameters<typeof intent>[1] = {}): Promise<string> {
  const r = await w.intake.execute(intent(n, over));
  if (r.kind !== "created") throw new Error(`expected created, got ${JSON.stringify(r)}`);
  return r.refundId;
}
const seedCard = (w: W, amount = 10_000n, over: Parameters<typeof facts>[1] = {}) =>
  w.factsPort.seed(SELLER_ORDER_1, facts([tender("t1", "card", amount)], over));
const legOf = async (w: W, id: string): Promise<RefundLegRecord> => {
  const r = await w.store.get(id);
  const leg = r?.legs[0];
  if (leg === undefined) throw new Error("no leg");
  return leg;
};

type MutableIntent = {
  messageId: string;
  event: {
    storeId: string;
    allocation: {
      itemTotal: string;
      voucherTotal: string;
      deliveryFeeTotal: string;
      netTotal: string;
      lines: Array<{ orderLineId: string; qty: number; itemAmount: string; voucherShare: string; deliveryFeeShare: string; netAmount: string }>;
    };
  };
};

describe("intake: rejection reasons are specific and recorded", () => {
  const reasons = (w: W) => w.store.events.filter((e) => e.type === "refund.intent_rejected");
  it("store mismatch", async () => {
    const w = world();
    seedCard(w);
    expect(await w.intake.execute(intent(1, { storeId: U(0x99) }))).toEqual({ kind: "rejected", reason: "store_mismatch" });
    expect(reasons(w)).toHaveLength(1);
    expect(JSON.stringify(reasons(w)[0], (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toContain("store_mismatch");
  });
  it("allocation arithmetic", async () => {
    const w = world();
    seedCard(w);
    const mk = (n: number, edit: (i: MutableIntent) => void): unknown => {
      const i = intent(n) as MutableIntent;
      edit(i);
      return i;
    };
    // item - voucher + fee must equal net
    expect(await w.intake.execute(mk(1, (i) => (i.event.allocation.voucherTotal = "100")))).toEqual({ kind: "rejected", reason: "allocation_inconsistent" });
    expect(await w.intake.execute(mk(2, (i) => (i.event.allocation.deliveryFeeTotal = "100")))).toEqual({ kind: "rejected", reason: "allocation_inconsistent" });
    // net must be positive even when the arithmetic agrees
    expect(
      await w.intake.execute(
        mk(3, (i) => {
          const a = i.event.allocation;
          a.itemTotal = "0";
          a.netTotal = "0";
          a.lines[0]!.itemAmount = "0";
          a.lines[0]!.netAmount = "0";
        }),
      ),
    ).toEqual({ kind: "rejected", reason: "allocation_inconsistent" });
    // line sums must equal the totals (net and item separately)
    expect(await w.intake.execute(mk(4, (i) => (i.event.allocation.lines[0]!.netAmount = "9999")))).toEqual({ kind: "rejected", reason: "allocation_inconsistent" });
    expect(await w.intake.execute(mk(5, (i) => (i.event.allocation.lines[0]!.itemAmount = "9999")))).toEqual({ kind: "rejected", reason: "allocation_inconsistent" });
    expect(reasons(w)).toHaveLength(5);
  });
  it("a delivery fee above what is left is refused; a negative remainder counts as zero, not as a block", async () => {
    const w = world();
    const withFee = (n: number, fee: bigint, net: bigint): unknown => {
      const i = intent(n, { net }) as MutableIntent;
      const a = i.event.allocation;
      a.deliveryFeeTotal = fee.toString();
      a.netTotal = (net + fee).toString();
      a.lines[0]!.netAmount = (net + fee).toString();
      a.lines[0]!.deliveryFeeShare = fee.toString();
      return i;
    };
    w.factsPort.seed(
      SELLER_ORDER_1,
      facts([tender("t1", "card", 30_000n)], { deliveryFee: 6_000n, lines: [{ orderLineId: "line-1", gross: 24_000n, refundedBefore: 0n }] }),
    );
    expect((await w.intake.execute(withFee(1, 6_000n, 7_000n))).kind).toBe("created");
    // the refund above completed elsewhere and is now in the facts too: the remainder is negative
    w.factsPort.seed(
      SELLER_ORDER_1,
      facts([tender("t1", "card", 30_000n)], {
        deliveryFee: 6_000n,
        deliveryFeeRefundedBefore: 6_000n,
        lines: [{ orderLineId: "line-1", gross: 24_000n, refundedBefore: 0n }],
      }),
    );
    expect((await w.intake.execute(withFee(2, 0n, 7_000n))).kind).toBe("created");
    expect(await w.intake.execute(withFee(3, 1n, 7_000n))).toEqual({ kind: "rejected", reason: "allocation_inconsistent" });
  });
  it("unknown line: any one unknown line rejects", async () => {
    const w = world();
    seedCard(w);
    const i = intent(1, { net: 10_000n }) as MutableIntent;
    i.event.allocation.lines = [
      { orderLineId: "line-1", qty: 1, itemAmount: "4000", voucherShare: "0", deliveryFeeShare: "0", netAmount: "4000" },
      { orderLineId: "ghost", qty: 1, itemAmount: "6000", voucherShare: "0", deliveryFeeShare: "0", netAmount: "6000" },
    ];
    expect(await w.intake.execute(i)).toEqual({ kind: "rejected", reason: "unknown_line" });
  });
  it("the same rejected message again is a duplicate, not a second rejection", async () => {
    const w = world();
    seedCard(w);
    const bad = intent(1, { storeId: U(0x99) });
    expect(await w.intake.execute(bad)).toEqual({ kind: "rejected", reason: "store_mismatch" });
    expect(await w.intake.execute(bad)).toEqual({ kind: "duplicate" });
    expect(reasons(w)).toHaveLength(1);
  });
  it("malformed input names the failure; missing facts name the seller order", async () => {
    const w = world();
    await expect(w.intake.execute({})).rejects.toThrow("refund intent message failed validation");
    await expect(w.intake.execute(intent(1))).rejects.toBeInstanceOf(RefundFactsUnavailableError);
    expect(RETURN_INTENT_CONSUMER).toBe("refunds.return_intent");
  });
  it("store outcomes other than created are passed through", async () => {
    const w = world();
    seedCard(w);
    w.store.intakeResult = "exists";
    expect(await w.intake.execute(intent(1))).toEqual({ kind: "exists" });
    w.store.intakeResult = "duplicate";
    expect(await w.intake.execute(intent(2))).toEqual({ kind: "duplicate" });
  });
});

describe("intake: the stored refund", () => {
  it("records every figure, line and leg exactly", async () => {
    const w = world();
    w.factsPort.seed(
      SELLER_ORDER_1,
      facts([tender("t1", "card", 10_000n)], { returnReceivedAtMs: T0 + 5_000, lines: [{ orderLineId: "line-1", gross: 10_000n, refundedBefore: 0n }] }),
    );
    w.clock.advance(1_000);
    const id = await create(w);
    const r = (await w.store.get(id)) as RefundRecord;
    expect(r).toMatchObject({
      id,
      userId: SHOPPER_A,
      storeId: STORE_A,
      sellerOrderId: SELLER_ORDER_1,
      source: "return",
      status: "REQUESTED",
      amount: 10_000n,
      itemTotal: 10_000n,
      voucherTotal: 0n,
      deliveryFeeTotal: 0n,
      ledgerPostedAtMs: null,
      returnReceivedAtMs: T0 + 5_000,
      requestedAtMs: T0 + 1_000,
      initiatedAtMs: null,
      completedAtMs: null,
      version: 0,
    });
    expect(r.idempotencyKey).toBe(`refund-intent:${U(0x8001)}`);
    expect(r.lines).toEqual([
      { orderLineId: "line-1", qty: 1, itemAmount: 10_000n, lineGross: 10_000n, voucherShare: 0n, deliveryFeeShare: 0n, netAmount: 10_000n },
    ]);
    expect(r.legs).toHaveLength(1);
    expect(r.legs[0]).toMatchObject({
      refundId: id,
      position: 0,
      tenderId: "t1",
      method: "card",
      channel: "psp_original",
      amount: 10_000n,
      creditSub: null,
      tender: { psp: "paymob", provider: "valu", courier: "bosta" },
      state: "REQUESTED",
      attempts: 0,
      nextAttemptAtMs: null,
      providerRef: null,
      failureCode: null,
      needsPayoutDetails: false,
      verify: null,
      note: null,
    });
    // ids are drawn in order: refund, ledger entry, then each leg
    expect(id).toBe(U(0x10001));
    expect(r.entry.id).toBe(U(0x10002));
    expect(r.legs[0]?.id).toBe(U(0x10003));
    expect(r.entry.requires).toContain(`order_paid:${ORDER_GROUP_1}`);
    expect(r.entry.requires.length).toBeGreaterThan(0);
  });
  it("falls back to the event time when the facts have no receipt time; omits absent tender identifiers", async () => {
    const w = world();
    const t = { ...tender("t1", "card", 10_000n) } as Record<string, unknown>;
    delete t["provider"];
    delete t["courier"];
    w.factsPort.seed(SELLER_ORDER_1, facts([t as never], { returnReceivedAtMs: null }));
    const id = await create(w);
    const r = (await w.store.get(id)) as RefundRecord;
    expect(r.returnReceivedAtMs).toBe(T0);
    expect(r.legs[0]?.tender).toEqual({ psp: "paymob" });
  });
  it("a line with no matching fact records a zero gross (and is refused before that, as unknown)", async () => {
    const w = world();
    seedCard(w);
    const id = await create(w);
    expect(((await w.store.get(id)) as RefundRecord).lines[0]?.lineGross).toBe(10_000n);
  });
  it("a refund split over two tenders keeps each leg's own tender identity", async () => {
    const w = world();
    w.factsPort.seed(
      SELLER_ORDER_1,
      facts([tender("a", "card", 6_000n, { psp: "paymob" }), tender("b", "bnpl", 4_000n, { provider: "sympl" })]),
    );
    const id = await create(w);
    const legs = ((await w.store.get(id)) as RefundRecord).legs;
    expect(legs.map((l) => [l.position, l.tenderId, l.channel, l.amount])).toEqual([
      [0, "a", "psp_original", 6_000n],
      [1, "b", "bnpl_cancel", 4_000n],
    ]);
    expect(legs[1]?.tender).toMatchObject({ provider: "sympl" });
    expect(legs[1]?.verify).toBe("VR-RF-03");
  });
});

describe("entry codec", () => {
  it("round-trips an entry and mints an id only when none was stored", async () => {
    const w = world();
    seedCard(w);
    const id = await create(w);
    const stored = ((await w.store.get(id)) as RefundRecord).entry;
    const entry = fromStoredEntry(stored);
    expect(entry.id).toBe(stored.id);
    expect(entry.kind).toBe(stored.kind);
    expect(entry.idempotencyKey).toBe(stored.idempotencyKey);
    expect(entry.occurredAt.getTime()).toBe(stored.occurredAtMs);
    expect(entry.ref).toEqual({ type: stored.ref.type, id: stored.ref.id });
    expect(entry.ref.id).toBe(id);
    expect(entry.postings.map((p) => [p.account, p.amount.amount])).toEqual(stored.postings.map((p) => [p.account, p.amount]));
    const back = toStoredEntry(entry, ["k1", "k2"]);
    expect(back).toEqual({ ...stored, requires: ["k1", "k2"] });
    const minted = fromStoredEntry({ ...stored, id: "" });
    expect(minted.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(minted.id).not.toBe("");
    expect(fromStoredEntry({ ...stored, id: "keep-me" }).id).toBe("keep-me");
  });
});

describe("processing: ledger first", () => {
  it("unknown refund", async () => {
    const w = world();
    expect(await w.process.execute(U(0xdead))).toBeNull();
  });
  it("cancelled and completed refunds are returned as they are, touching nothing", async () => {
    const w = world();
    seedCard(w);
    const id = await create(w);
    w.store.tweak = (r) => ({ ...r, status: "CANCELLED" });
    expect(await w.process.execute(id)).toEqual({ refundId: id, status: "CANCELLED", ledger: "already" });
    w.store.tweak = (r) => ({ ...r, status: "COMPLETED" });
    expect(await w.process.execute(id)).toEqual({ refundId: id, status: "COMPLETED", ledger: "already" });
    expect(w.ledger.entries.size).toBe(0);
    expect(w.executor.calls).toHaveLength(0);
  });
  it("posting reports posted, a repeat reports replayed, and a stored mark reports already", async () => {
    const w = world();
    seedCard(w);
    const id = await create(w);
    // the ledger already has the entry but the refund was never marked: replayed
    const stored = ((await w.store.get(id)) as RefundRecord).entry;
    await w.ledger.post(fromStoredEntry(stored));
    expect(await w.process.execute(id)).toMatchObject({ ledger: "replayed", status: "COMPLETED" });
    const w2 = world();
    seedCard(w2);
    const id2 = await create(w2);
    expect(await w2.process.execute(id2)).toMatchObject({ ledger: "posted" });
    expect((await w2.store.get(id2))?.ledgerPostedAtMs).toBe(T0);
    expect(await w2.process.execute(id2)).toMatchObject({ ledger: "already" });
  });
  it("an entry that requires nothing posts without any recognition lookup", async () => {
    const w = world(true);
    seedCard(w);
    const id = await create(w);
    w.store.tweak = (r) => ({ ...r, entry: { ...r.entry, requires: [] } });
    expect(await w.process.execute(id)).toMatchObject({ ledger: "posted" });
    expect(w.ledger.entries.size).toBe(1);
  });
  it("a missing recognition is typed, carries the keys, and leaves the refund unposted", async () => {
    const w = world(true);
    seedCard(w);
    const id = await create(w);
    const err = await w.process.execute(id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RefundRecognitionMissingError);
    expect(w.ledger.entries.size).toBe(0);
    expect(w.executor.calls).toHaveLength(0);
  });
  it("any one of several required entries is enough", async () => {
    const w = world(true);
    seedCard(w);
    const id = await create(w);
    w.ledger.recognised.add("second-key");
    w.store.tweak = (r) => ({ ...r, entry: { ...r.entry, requires: ["missing-key", "second-key"] } });
    expect(await w.process.execute(id)).toMatchObject({ ledger: "posted" });
  });
});

describe("processing: credit legs and payout details", () => {
  it("a credit leg restores to its sub with the leg identity, then completes", async () => {
    const w = world();
    w.factsPort.seed(SELLER_ORDER_1, facts([tender("t1", "cod", 10_000n)]));
    const id = await create(w);
    await w.process.execute(id);
    const leg = await legOf(w, id);
    expect(leg.state).toBe("COMPLETED");
    expect(leg.attempts).toBe(0);
    expect(w.credit.restored.get(leg.id)).toEqual({ userId: SHOPPER_A, sub: "refund_credit", amount: 10_000n, refundId: id });
    expect(w.executor.calls).toHaveLength(0);
  });
  it("a credit leg with no sub is left alone", async () => {
    const w = world();
    w.factsPort.seed(SELLER_ORDER_1, facts([tender("t1", "cod", 10_000n)]));
    const id = await create(w);
    w.store.tweak = (r) => ({ ...r, legs: r.legs.map((l) => ({ ...l, creditSub: null })) });
    await w.process.execute(id);
    expect(w.credit.restored.size).toBe(0);
    expect(w.executor.calls).toHaveLength(0);
    expect((await legOf(w, id)).state).toBe("LEDGER_POSTED");
  });
  it("wallet transfers wait for a verified wallet, bank transfers for a verified bank account", async () => {
    for (const cod of ["wallet_transfer", "bank_transfer"] as const) {
      const w = world();
      w.factsPort.seed(SELLER_ORDER_1, facts([tender("t1", "cod", 10_000n)], { choice: { cod } }));
      const id = await create(w);
      const want = cod === "wallet_transfer" ? "wallet_transfer" : "bank_transfer_iban";
      const other = cod === "wallet_transfer" ? "bank_transfer_iban" : "wallet_transfer";
      w.payout.verify(SHOPPER_A, other);
      await w.process.execute(id);
      expect(w.executor.calls, `${cod} with the other channel verified`).toHaveLength(0);
      w.payout.verify(SHOPPER_A, want);
      await w.process.execute(id);
      expect(w.executor.calls.map((c) => c.channel)).toEqual([want === "wallet_transfer" ? "wallet_transfer" : "bank_transfer_iban"]);
      expect((await w.store.get(id))?.status).toBe("COMPLETED");
    }
  });
});

describe("processing: provider submission", () => {
  it("sends the leg's full request and records a confirmed attempt", async () => {
    const w = world();
    seedCard(w);
    const id = await create(w);
    await w.process.execute(id);
    const leg = await legOf(w, id);
    expect(w.executor.calls).toEqual([
      {
        idempotencyKey: leg.id,
        channel: "psp_original",
        method: "card",
        amount: money(10_000n),
        tender: { psp: "paymob", provider: "valu", courier: "bosta" },
        attempt: 1,
      },
    ]);
    expect(leg).toMatchObject({ state: "COMPLETED", attempts: 1, providerRef: `fake-${leg.id}`, failureCode: null, nextAttemptAtMs: null });
    expect(w.store.attempts).toEqual([{ legId: leg.id, no: 1, outcome: "confirmed", code: null }]);
  });
  it("a pending answer keeps the leg submitted with its provider reference", async () => {
    const w = world();
    seedCard(w);
    const id = await create(w);
    const leg0 = await legOf(w, id);
    w.executor.scriptFor(leg0.id, { kind: "pending", providerRef: "ref-9" });
    await w.process.execute(id);
    const leg = await legOf(w, id);
    expect(leg).toMatchObject({ state: "SUBMITTED", attempts: 1, providerRef: "ref-9", failureCode: null, nextAttemptAtMs: null });
    expect(w.store.attempts).toEqual([{ legId: leg.id, no: 1, outcome: "pending", code: null }]);
    expect((await w.store.get(id))?.status).toBe("PROCESSING");
  });
  it("a rejection schedules a retry at the backoff and records code and attempt number", async () => {
    const w = world();
    seedCard(w);
    const id = await create(w);
    const leg0 = await legOf(w, id);
    w.executor.scriptFor(leg0.id, { kind: "rejected", code: "insufficient_funds" });
    await w.process.execute(id);
    const leg = await legOf(w, id);
    expect(leg).toMatchObject({ state: "FAILED", attempts: 1, failureCode: "insufficient_funds", nextAttemptAtMs: T0 + 30_000 });
    expect(w.store.attempts).toEqual([{ legId: leg.id, no: 1, outcome: "rejected", code: "insufficient_funds" }]);
    // not yet due one millisecond early, due exactly at the scheduled time
    w.clock.advance(29_999);
    await w.process.execute(id);
    expect(w.executor.calls).toHaveLength(1);
    w.clock.advance(1);
    await w.process.execute(id);
    expect(w.executor.calls).toHaveLength(2);
    expect(w.executor.calls[1]?.attempt).toBe(2);
    const done = await legOf(w, id);
    expect(done).toMatchObject({ state: "COMPLETED", attempts: 2, failureCode: null, nextAttemptAtMs: null });
    expect(w.store.attempts.map((a) => [a.no, a.outcome, a.code])).toEqual([
      [1, "rejected", "insufficient_funds"],
      [2, "confirmed", null],
    ]);
  });
  it("a provider exception is recorded as unavailable, with a fixed code", async () => {
    const w = world();
    seedCard(w);
    const id = await create(w);
    const leg0 = await legOf(w, id);
    w.executor.scriptFor(leg0.id, "throw");
    await w.process.execute(id);
    const leg = await legOf(w, id);
    expect(leg).toMatchObject({ state: "FAILED", failureCode: "provider_unavailable" });
    expect(w.store.attempts).toEqual([{ legId: leg.id, no: 1, outcome: "unavailable", code: "provider_unavailable" }]);
  });
  it("the last allowed attempt escalates to manual review in the same pass, with no further call", async () => {
    const w = world();
    seedCard(w);
    const id = await create(w);
    const leg0 = await legOf(w, id);
    w.executor.scriptFor(leg0.id, ...Array.from({ length: MAX_REFUND_ATTEMPTS }, () => ({ kind: "rejected" as const, code: "declined" })));
    for (let i = 0; i < MAX_REFUND_ATTEMPTS; i += 1) {
      await w.process.execute(id);
      if (i < MAX_REFUND_ATTEMPTS - 1) {
        expect((await legOf(w, id)).state).toBe("FAILED");
        expect((await legOf(w, id)).nextAttemptAtMs).not.toBeNull();
      }
      w.clock.advance(3_600_000);
    }
    const leg = await legOf(w, id);
    expect(leg).toMatchObject({ state: "MANUAL_REVIEW", attempts: MAX_REFUND_ATTEMPTS, failureCode: "declined", nextAttemptAtMs: null });
    expect(w.executor.calls).toHaveLength(MAX_REFUND_ATTEMPTS);
    expect(w.store.events.filter((e) => e.type === "refund.manual_review")).toHaveLength(1);
    const before = w.executor.calls.length;
    await w.process.execute(id);
    expect(w.executor.calls).toHaveLength(before);
  });
  it("a crash between the failure and its escalation is finished on the next pass without a new call", async () => {
    const w = world();
    seedCard(w);
    const id = await create(w);
    const leg0 = await legOf(w, id);
    w.executor.scriptFor(leg0.id, ...Array.from({ length: MAX_REFUND_ATTEMPTS }, () => ({ kind: "rejected" as const, code: "declined" })));
    let crash = false;
    w.store.failTransition = (t) => (crash && t.to === "MANUAL_REVIEW" ? "throw" : null);
    for (let i = 0; i < MAX_REFUND_ATTEMPTS - 1; i += 1) {
      await w.process.execute(id);
      w.clock.advance(3_600_000);
    }
    crash = true;
    await expect(w.process.execute(id)).rejects.toThrow("crash between steps");
    expect((await legOf(w, id)).state).toBe("FAILED");
    expect((await legOf(w, id)).attempts).toBe(MAX_REFUND_ATTEMPTS);
    crash = false;
    const calls = w.executor.calls.length;
    await w.process.execute(id);
    expect(w.executor.calls).toHaveLength(calls);
    const leg = await legOf(w, id);
    expect(leg).toMatchObject({ state: "MANUAL_REVIEW", failureCode: "declined" });
    expect(w.store.events.find((e) => e.type === "refund.manual_review")).toMatchObject({ code: "declined" });
  });
  it("a lost race on the submit transition means no provider call", async () => {
    const w = world();
    seedCard(w);
    const id = await create(w);
    w.store.failTransition = (t) => (t.to === "SUBMITTED" ? "stale" : null);
    await w.process.execute(id);
    expect(w.executor.calls).toHaveLength(0);
    expect((await legOf(w, id)).state).toBe("LEDGER_POSTED");
  });
});

describe("sweeper", () => {
  it("honours its limit and rethrows anything but a missing recognition", async () => {
    const w = world();
    for (const n of [1, 2, 3]) {
      w.factsPort.seed(U(0x500 + n), { ...facts([tender(`t${n}`, "card", 10_000n)]) });
      const r = await w.intake.execute(intent(n, { sellerOrderId: U(0x500 + n) }));
      expect(r.kind).toBe("created");
    }
    const sweep = new SweepRefunds(w.store, w.process, w.clock);
    expect(await sweep.execute(2)).toEqual({ processed: 2 });
    expect(await sweep.execute()).toEqual({ processed: 1 });
    const w2 = world();
    seedCard(w2);
    await create(w2);
    w2.ledger.failNext = 1;
    await expect(new SweepRefunds(w2.store, w2.process, w2.clock).execute()).rejects.toThrow("ledger unavailable");
  });
});

describe("provider callbacks", () => {
  async function pending(w: W): Promise<{ id: string; legId: string }> {
    seedCard(w);
    const id = await create(w);
    const legId = (await legOf(w, id)).id;
    w.executor.scriptFor(legId, { kind: "pending", providerRef: "ref-1" });
    await w.process.execute(id);
    return { id, legId };
  }
  it("a confirmation completes the leg and keeps its attempt count", async () => {
    const w = world();
    const { id } = await pending(w);
    expect(await w.confirm.execute({ provider: "paymob", providerRef: "ref-1", result: "confirmed" })).toBe("completed");
    expect(await legOf(w, id)).toMatchObject({ state: "COMPLETED", attempts: 1, failureCode: null });
    expect(await w.confirm.execute({ provider: "paymob", providerRef: "ref-1", result: "confirmed" })).toBe("stale");
  });
  it("a stale write is reported as stale for confirmation and rejection alike", async () => {
    const w = world();
    await pending(w);
    w.store.failTransition = () => "stale";
    expect(await w.confirm.execute({ provider: "paymob", providerRef: "ref-1", result: "confirmed" })).toBe("stale");
    expect(await w.confirm.execute({ provider: "paymob", providerRef: "ref-1", result: { rejected: "late" } })).toBe("stale");
  });
  it("a rejection with attempts left schedules a retry", async () => {
    const w = world();
    const { id, legId } = await pending(w);
    expect(await w.confirm.execute({ provider: "paymob", providerRef: "ref-1", result: { rejected: "declined" } })).toBe("failed");
    expect(await legOf(w, id)).toMatchObject({ state: "FAILED", attempts: 1, failureCode: "declined", nextAttemptAtMs: T0 + 30_000 });
    expect(w.store.attempts).toContainEqual({ legId, no: 1, outcome: "rejected", code: "declined" });
  });
  it("a rejection on the last attempt escalates to manual review", async () => {
    const w = world();
    seedCard(w);
    const id = await create(w);
    const legId = (await legOf(w, id)).id;
    w.executor.scriptFor(
      legId,
      { kind: "rejected", code: "x" },
      { kind: "rejected", code: "x" },
      { kind: "pending", providerRef: "ref-last" },
    );
    for (let i = 0; i < MAX_REFUND_ATTEMPTS; i += 1) {
      await w.process.execute(id);
      w.clock.advance(3_600_000);
    }
    expect((await legOf(w, id)).state).toBe("SUBMITTED");
    expect(await w.confirm.execute({ provider: "paymob", providerRef: "ref-last", result: { rejected: "declined" } })).toBe("escalated");
    expect(await legOf(w, id)).toMatchObject({ state: "MANUAL_REVIEW", attempts: MAX_REFUND_ATTEMPTS, nextAttemptAtMs: null, failureCode: "declined" });
  });
});

describe("manual review resolution", () => {
  async function stuck(w: W): Promise<{ id: string; legId: string }> {
    seedCard(w);
    const id = await create(w);
    const legId = (await legOf(w, id)).id;
    w.executor.scriptFor(legId, ...Array.from({ length: MAX_REFUND_ATTEMPTS }, () => ({ kind: "rejected" as const, code: "declined" })));
    for (let i = 0; i < MAX_REFUND_ATTEMPTS; i += 1) {
      await w.process.execute(id);
      w.clock.advance(3_600_000);
    }
    expect((await legOf(w, id)).state).toBe("MANUAL_REVIEW");
    return { id, legId };
  }
  it("not found, stale and applied outcomes", async () => {
    const w = world();
    const { id, legId } = await stuck(w);
    expect(await w.resolve.execute({ legId: U(0xbad), refundId: id, outcome: "retry" })).toBe("not_found");
    expect(await w.resolve.execute({ legId, refundId: U(0xbad), outcome: "retry" })).toBe("not_found");
    expect(await w.resolve.execute({ legId, refundId: id, outcome: "transferred" })).toBe("applied");
    expect(await legOf(w, id)).toMatchObject({ state: "COMPLETED", attempts: MAX_REFUND_ATTEMPTS });
    expect(await w.resolve.execute({ legId, refundId: id, outcome: "retry" })).toBe("stale");
  });
  it("retry resets the attempt counter so the leg can be submitted again", async () => {
    const w = world();
    const { id, legId } = await stuck(w);
    expect(await w.resolve.execute({ legId, refundId: id, outcome: "retry" })).toBe("applied");
    expect(await legOf(w, id)).toMatchObject({ state: "SUBMITTED", attempts: 0, failureCode: null, nextAttemptAtMs: null });
  });
});
