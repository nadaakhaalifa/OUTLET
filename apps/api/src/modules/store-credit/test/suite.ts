import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { addMonthsUtc, chart, createJournalEntry, money, type StoreCreditSub } from "../domain/bridge";
import { InMemoryCreditLedger } from "../adapters/in-memory";
import { CreditHolds, GrantCredit, ReconcileWallets, RestoreRefundCredit, SweepExpiredCredit } from "../application/credit";
import { GetWallet, ListWalletTransactions } from "../application/queries";
import type { ClockPort, IdPort, StoreCreditStore } from "../domain/ports";

export const T0 = Date.UTC(2026, 9, 1, 9, 0, 0);
export const U = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
export const USER_A = U(0xa1);
export const USER_B = U(0xb1);

export class TestClock implements ClockPort {
  constructor(public ms: number = T0) {}
  nowMs(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}
export class SeqIds implements IdPort {
  constructor(private n = 0x10000) {}
  uuidV7(): string {
    this.n += 1;
    return U(this.n);
  }
}

export interface CreditWorld {
  readonly store: StoreCreditStore;
  readonly ensureUser: (id: string) => Promise<void>;
}

const DAY = 86_400_000;

export function describeStoreCreditSuite(name: string, make: () => Promise<CreditWorld>): void {
  async function setup() {
    const w = await make();
    await w.ensureUser(USER_A);
    await w.ensureUser(USER_B);
    const clock = new TestClock();
    const ids = new SeqIds();
    const ledger = new InMemoryCreditLedger();
    const restore = new RestoreRefundCredit(w.store, ids, clock);
    /** What the refund saga does: the refund's ledger entry first, then the restore keyed by the leg. */
    const refundCredit = async (userId: string, amount: bigint, legNo: number): Promise<void> => {
      await ledger.post(
        createJournalEntry({
          id: U(0x500 + legNo),
          idempotencyKey: `refund-entry-${legNo}`,
          occurredAt: new Date(clock.nowMs()),
          kind: "refund_issued",
          ref: { type: "refund", id: U(legNo) },
          postings: [
            { account: chart.sellerPayable("store-1"), amount: money(amount) },
            { account: chart.storeCredit(userId, { kind: "refund_credit" }), amount: money(-amount) },
          ],
        }),
      );
      await restore.restore({ userId, sub: { kind: "refund_credit" }, amount: money(amount), refundId: U(legNo), legId: U(0x100 + legNo) });
    };
    return {
      ...w,
      refundCredit,
      clock,
      ledger,
      grant: new GrantCredit(w.store, ledger, ids, clock),
      holds: new CreditHolds(w.store, ids, clock),
      sweep: new SweepExpiredCredit(w.store, ledger, ids, clock),
      reconcile: new ReconcileWallets(w.store, ledger),
      restore,
      wallet: new GetWallet(w.store, clock),
      txns: new ListWalletTransactions(w.store),
    };
  }

  describe(`store credit: ${name}`, () => {
    it("grants are idempotent on the key: one lot, one ledger entry, one transaction", async () => {
      const s = await setup();
      const sub: StoreCreditSub = { kind: "goodwill" };
      expect(await s.grant.promo({ userId: USER_A, sub, amount: money(5_000n), key: "g-1" })).toBe("granted");
      expect(await s.grant.promo({ userId: USER_A, sub, amount: money(5_000n), key: "g-1" })).toBe("exists");
      expect(s.ledger.entries.size).toBe(1);
      const w = await s.wallet.execute(USER_A);
      expect(w.totalAvailable).toBe(5_000n);
      expect((await s.txns.execute(USER_A, null, 10)).items).toHaveLength(1);
    });

    it("expiry terms: coins 12 months, referral 6 months, goodwill 90 days, refund credit never", async () => {
      const s = await setup();
      for (const [kind, key] of [["cashback_coins", "c"], ["referral_credit", "r"], ["goodwill", "g"]] as const) {
        await s.grant.promo({ userId: USER_A, sub: { kind }, amount: money(1_000n), key });
      }
      await s.refundCredit(USER_A, 1_000n, 1);
      const lots = await s.store.listLots(USER_A);
      const by = new Map(lots.map((l) => [l.sub.kind, l.expiresAtMs] as const));
      expect(by.get("cashback_coins")).toBe(addMonthsUtc(T0, 12));
      expect(by.get("referral_credit")).toBe(addMonthsUtc(T0, 6));
      expect(by.get("goodwill")).toBe(T0 + 90 * DAY);
      expect(by.get("refund_credit")).toBeNull();
    });

    it("spends soonest-expiring first and refund credit last, then release restores everything", async () => {
      const s = await setup();
      await s.refundCredit(USER_A, 3_000n, 1);
      await s.grant.promo({ userId: USER_A, sub: { kind: "cashback_coins" }, amount: money(1_000n), key: "c" });
      await s.grant.promo({ userId: USER_A, sub: { kind: "goodwill" }, amount: money(1_000n), key: "g" });
      const r = await s.holds.hold({ userId: USER_A, ref: "checkout-1", amount: money(2_500n) });
      expect(r.kind).toBe("held");
      if (r.kind !== "held") return;
      const taken = Object.fromEntries(r.hold.lines.map((l) => [l.sub.kind, l.amount]));
      expect(taken).toEqual({ goodwill: 1_000n, cashback_coins: 1_000n, refund_credit: 500n });
      expect(r.hold.lines.reduce((a, l) => a + l.amount, 0n)).toBe(2_500n);
      // held credit is not spendable twice
      expect((await s.holds.hold({ userId: USER_A, ref: "checkout-2", amount: money(2_600n) })).kind).toBe("insufficient");
      expect(await s.holds.release(USER_A, "checkout-1")).toBe("released");
      expect(await s.holds.release(USER_A, "checkout-1")).toBe("not_held");
      expect((await s.wallet.execute(USER_A)).totalAvailable).toBe(5_000n);
    });

    it("a hold is idempotent per (user, ref) and invisible to other users", async () => {
      const s = await setup();
      await s.grant.promo({ userId: USER_A, sub: { kind: "goodwill" }, amount: money(1_000n), key: "g" });
      const a = await s.holds.hold({ userId: USER_A, ref: "x", amount: money(400n) });
      const b = await s.holds.hold({ userId: USER_A, ref: "x", amount: money(400n) });
      expect(a.kind).toBe("held");
      expect(b.kind).toBe("exists");
      expect((await s.wallet.execute(USER_A)).totalHeld).toBe(400n);
      expect(await s.holds.release(USER_B, "x")).toBe("not_found");
    });

    it("ADV-W4-2: concurrent holds for one user are atomic, only one can take the same credit", async () => {
      const s = await setup();
      await s.grant.promo({ userId: USER_A, sub: { kind: "goodwill" }, amount: money(1_000n), key: "g" });
      const rs = await Promise.all(
        ["a", "b", "c", "d"].map((ref) => s.holds.hold({ userId: USER_A, ref, amount: money(1_000n) })),
      );
      expect(rs.filter((r) => r.kind === "held")).toHaveLength(1);
      expect(rs.filter((r) => r.kind === "insufficient")).toHaveLength(3);
      const w = await s.wallet.execute(USER_A);
      expect(w.totalHeld).toBe(1_000n);
      expect(w.totalAvailable).toBe(0n);
    });

    it("a hold with its own ttl is not swept by the default window", async () => {
      const s = await setup();
      await s.grant.promo({ userId: USER_A, sub: { kind: "goodwill" }, amount: money(1_000n), key: "g" });
      await s.holds.hold({ userId: USER_A, ref: "long", amount: money(500n), ttlMs: 2 * 3_600_000 });
      s.clock.advance(11 * 60_000);
      expect((await s.holds.sweepExpired()).released).toBe(0);
      s.clock.advance(2 * 3_600_000);
      expect((await s.holds.sweepExpired()).released).toBe(1);
    });

    it("R-6: the sweeper never releases a hold whose saga is live, even past its TTL", async () => {
      const s = await setup();
      const live = new Set<string>(["saga-live"]);
      const guarded = new CreditHolds(s.store, new SeqIds(), s.clock, undefined, async (ref) => live.has(ref));
      await s.grant.promo({ userId: USER_A, sub: { kind: "goodwill" }, amount: money(1_000n), key: "g" });
      await guarded.hold({ userId: USER_A, ref: "saga-live", amount: money(400n) });
      await guarded.hold({ userId: USER_A, ref: "saga-dead", amount: money(300n) });
      s.clock.advance(60 * 60_000);
      expect((await guarded.sweepExpired()).released).toBe(1);
      expect((await s.wallet.execute(USER_A)).totalHeld).toBe(400n);
      live.clear();
      expect((await guarded.sweepExpired()).released).toBe(1);
      expect((await s.wallet.execute(USER_A)).totalHeld).toBe(0n);
    });

    it("capture consumes the credit once and reconciliation tolerates the not-yet-posted order entry", async () => {
      const s = await setup();
      await s.grant.promo({ userId: USER_A, sub: { kind: "goodwill" }, amount: money(1_000n), key: "g" });
      await s.holds.hold({ userId: USER_A, ref: "o-1", amount: money(600n) });
      const c = await s.holds.capture({ userId: USER_A, ref: "o-1", orderEntryKey: "order-entry-1" });
      expect(c.kind).toBe("captured");
      // The same capture again is a replay (idempotent), a different entry key is not.
      expect((await s.holds.capture({ userId: USER_A, ref: "o-1", orderEntryKey: "order-entry-1" })).kind).toBe("captured");
      expect((await s.holds.capture({ userId: USER_A, ref: "o-1", orderEntryKey: "other-entry" })).kind).toBe("not_held");
      const w = await s.wallet.execute(USER_A);
      expect(w.totalAvailable).toBe(400n);
      expect((await s.reconcile.execute()).drift).toEqual([]);
    });

    it("an expired hold is released by the sweeper, exactly once", async () => {
      const s = await setup();
      await s.grant.promo({ userId: USER_A, sub: { kind: "goodwill" }, amount: money(1_000n), key: "g" });
      await s.holds.hold({ userId: USER_A, ref: "o-1", amount: money(600n) });
      s.clock.advance(11 * 60_000);
      expect(await s.holds.sweepExpired()).toEqual({ released: 1 });
      expect(await s.holds.sweepExpired()).toEqual({ released: 0 });
      expect((await s.wallet.execute(USER_A)).totalAvailable).toBe(1_000n);
    });

    it("the expiry sweeper writes off platform credit once, never gift cards or refund credit", async () => {
      const s = await setup();
      await s.grant.promo({ userId: USER_A, sub: { kind: "goodwill" }, amount: money(1_000n), key: "g" });
      await s.grant.giftCardRedeemed({ userId: USER_A, cardId: "card-1", amount: money(2_000n), expiresAtMs: T0 + 100 * DAY, key: "gc" });
      await s.refundCredit(USER_A, 500n, 1);
      s.clock.advance(400 * DAY);
      expect(await s.sweep.execute()).toEqual({ expired: 1, amount: 1_000n });
      expect(await s.sweep.execute()).toEqual({ expired: 0, amount: 0n });
      const w = await s.wallet.execute(USER_A);
      expect(w.balances.map((b) => b.sub.kind)).toEqual(["refund_credit"]);
      expect((await s.reconcile.execute()).drift).toEqual([]);
    });

    it("an expired lot is not spendable even before the sweeper runs", async () => {
      const s = await setup();
      await s.grant.promo({ userId: USER_A, sub: { kind: "goodwill" }, amount: money(1_000n), key: "g" });
      s.clock.advance(91 * DAY);
      expect((await s.holds.hold({ userId: USER_A, ref: "x", amount: money(1n) })).kind).toBe("insufficient");
    });

    it("refund restore is idempotent on the leg id", async () => {
      const s = await setup();
      const input = { userId: USER_A, sub: { kind: "refund_credit" } as const, amount: money(700n), refundId: U(1), legId: U(2) };
      await s.restore.restore(input);
      await s.restore.restore(input);
      expect((await s.wallet.execute(USER_A)).totalAvailable).toBe(700n);
    });

    it("reconciliation reports drift when a lot has no ledger posting, and does not fix it", async () => {
      const s = await setup();
      await s.store.addLot({
        lot: { id: U(0x77), userId: USER_A, sub: { kind: "goodwill" }, granted: 900n, remaining: 900n, held: 0n, expiresAtMs: T0 + 90 * DAY, createdAtMs: T0, sourceKey: "orphan" },
        txn: { id: U(0x78), userId: USER_A, kind: "credit_added", reason: "goodwill", sub: { kind: "goodwill" }, amount: 900n, ref: "orphan", dedupeKey: "added:orphan", createdAtMs: T0 },
      });
      const r = await s.reconcile.execute();
      expect(r.drift).toHaveLength(1);
      expect(r.drift[0]?.userId).toBe(USER_A);
      expect((await s.reconcile.execute()).drift).toHaveLength(1);
    });

    it("transactions page newest first with a cursor and are per user", async () => {
      const s = await setup();
      for (let i = 0; i < 5; i += 1) {
        s.clock.advance(1000);
        await s.grant.promo({ userId: USER_A, sub: { kind: "goodwill" }, amount: money(100n), key: `g${i}` });
      }
      await s.grant.promo({ userId: USER_B, sub: { kind: "goodwill" }, amount: money(100n), key: "b" });
      const p1 = await s.txns.execute(USER_A, null, 2);
      expect(p1.items).toHaveLength(2);
      expect(p1.hasMore).toBe(true);
      const last = p1.items[1];
      const p2 = await s.txns.execute(USER_A, { createdAtMs: last?.createdAtMs ?? 0, id: last?.id ?? "" }, 10);
      expect(p2.items).toHaveLength(3);
      const seen = new Set([...p1.items, ...p2.items].map((t) => t.id));
      expect(seen.size).toBe(5);
      expect([...p1.items, ...p2.items].every((t) => t.userId === USER_A)).toBe(true);
    });

    it("property: a hold takes exactly the amount, release returns exactly it, balances never go negative", async () => {
      const shared = await setup();
      let run = 0;
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.tuple(fc.constantFrom("cashback_coins", "referral_credit", "goodwill", "refund_credit" as const), fc.integer({ min: 1, max: 100_000 })),
            { minLength: 1, maxLength: 6 },
          ),
          fc.integer({ min: 1, max: 100 }),
          async (grants, pct) => {
            run += 1;
            const user = U(0x9000 + run);
            await shared.ensureUser(user);
            const s = shared;
            let total = 0n;
            let i = 0;
            for (const [kind, amt] of grants) {
              i += 1;
              await s.restore.restore({ userId: user, sub: { kind }, amount: money(BigInt(amt)), refundId: U(i), legId: U(0x20000 + run * 10 + i) });
              total += BigInt(amt);
            }
            const want = (total * BigInt(pct)) / 100n || 1n;
            const h = await s.holds.hold({ userId: user, ref: "p", amount: money(want) });
            expect(h.kind).toBe("held");
            if (h.kind !== "held") return;
            expect(h.hold.lines.reduce((a, l) => a + l.amount, 0n)).toBe(want);
            const mid = await s.wallet.execute(user);
            expect(mid.totalAvailable).toBe(total - want);
            expect(mid.balances.every((b) => b.available >= 0n && b.held >= 0n)).toBe(true);
            await s.holds.release(user, "p");
            expect((await s.wallet.execute(user)).totalAvailable).toBe(total);
          },
        ),
        { numRuns: 25 },
      );
    }, 120_000);
  });
}
