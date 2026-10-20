import { describe, expect, it } from "vitest";
import type { BudgetRecord, BudgetStore, CommitmentRecord, CycleRecord, SpendEventRecord } from "../domain/ports";

export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const text = (b: Uint8Array): string => new TextDecoder().decode(b);

export const budgetRec = (userId: string, over: Partial<BudgetRecord> = {}): BudgetRecord => ({
  userId,
  amountEnc: bytes("enc-amount"),
  perCategoryEnc: null,
  payday: 25,
  capMode: "off",
  holdUntilMs: null,
  version: 1,
  createdAtMs: 1_800_000_000_000,
  updatedAtMs: 1_800_000_000_000,
  ...over,
});
export const cycleRec = (userId: string, startMs: number, over: Partial<CycleRecord> = {}): CycleRecord => ({
  userId,
  startMs,
  endMs: startMs + 30 * 86_400_000,
  spentEnc: bytes("s"),
  refundedEnc: bytes("r"),
  refundReceivedEnc: bytes("rr"),
  rolledAtMs: startMs,
  updatedAtMs: startMs,
  ...over,
});
export const eventRec = (userId: string, key: string, placed: number, occurred = placed, kind: SpendEventRecord["kind"] = "placed"): SpendEventRecord => ({
  userId,
  key,
  kind,
  orderPlacedAtMs: placed,
  occurredAtMs: occurred,
  detailEnc: bytes(`detail-${key}`),
});
export const commitmentRec = (userId: string, provider: string, source: CommitmentRecord["source"], startsAtMs = 1_800_000_000_000): CommitmentRecord => ({
  userId,
  provider,
  source,
  startsAtMs,
  endsAtMs: startsAtMs + 90 * 86_400_000,
  monthlyEnc: bytes(`m-${provider}`),
});

export interface ContractContext {
  readonly store: BudgetStore;
  ensureUser(id: string): Promise<void>;
  eventTypes(): Promise<readonly string[]>;
}

const T0 = 1_800_000_000_000;

export function describeBudgetStoreContract(name: string, make: () => Promise<ContractContext>): void {
  describe(`BudgetStore contract: ${name}`, () => {
    it("stores and returns a budget as opaque bytes, and upserts", async () => {
      const c = await make();
      await c.ensureUser(U(1));
      await c.store.run(U(1), async (tx) => {
        expect(await tx.getBudget()).toBeNull();
        await tx.putBudget(budgetRec(U(1), { perCategoryEnc: bytes("cats") }));
      });
      await c.store.run(U(1), async (tx) => {
        const b = await tx.getBudget();
        expect(b && text(b.amountEnc)).toBe("enc-amount");
        expect(b && b.perCategoryEnc && text(b.perCategoryEnc)).toBe("cats");
        expect(b?.payday).toBe(25);
        await tx.putBudget(budgetRec(U(1), { capMode: "hard", holdUntilMs: T0 + 5, version: 2, updatedAtMs: T0 + 9 }));
      });
      const b = await c.store.read(U(1), (tx) => tx.getBudget());
      expect(b).toMatchObject({ capMode: "hard", holdUntilMs: T0 + 5, version: 2, updatedAtMs: T0 + 9, createdAtMs: T0 });
    });

    it("cycles are keyed by start and report inserted then updated", async () => {
      const c = await make();
      await c.ensureUser(U(1));
      await c.store.run(U(1), async (tx) => {
        await tx.putBudget(budgetRec(U(1)));
        expect(await tx.putCycle(cycleRec(U(1), T0))).toBe("inserted");
        expect(await tx.putCycle(cycleRec(U(1), T0, { spentEnc: bytes("s2") }))).toBe("updated");
        expect(await tx.putCycle(cycleRec(U(1), T0 + 1000))).toBe("inserted");
        const got = await tx.getCycle(T0);
        expect(got && text(got.spentEnc)).toBe("s2");
        expect((await tx.listCycles(10)).map((x) => x.startMs)).toEqual([T0 + 1000, T0]);
      });
    });

    it("spend events are idempotent by key, filtered by time, and deletable", async () => {
      const c = await make();
      await c.ensureUser(U(1));
      await c.store.run(U(1), async (tx) => {
        await tx.putBudget(budgetRec(U(1)));
        expect(await tx.insertSpendEvent(eventRec(U(1), "placed:a", T0))).toBe("inserted");
        expect(await tx.insertSpendEvent(eventRec(U(1), "placed:a", T0))).toBe("exists");
        await tx.insertSpendEvent(eventRec(U(1), "refund:old", T0 - 50_000_000, T0 + 10, "refund"));
        await tx.insertSpendEvent(eventRec(U(1), "placed:old", T0 - 90_000_000));
        const since = await tx.listSpendEvents(T0);
        expect(since.map((e) => e.key).sort()).toEqual(["placed:a", "refund:old"]);
        expect(await tx.deleteSpendEvent("placed:a")).toBe(true);
        expect(await tx.deleteSpendEvent("placed:a")).toBe(false);
      });
    });

    it("replaces commitments per source without touching the other source", async () => {
      const c = await make();
      await c.ensureUser(U(1));
      await c.store.run(U(1), async (tx) => {
        await tx.putBudget(budgetRec(U(1)));
        await tx.replaceCommitments("user", [commitmentRec(U(1), "valU", "user"), commitmentRec(U(1), "Sympl", "user")]);
        await tx.replaceCommitments("provider", [commitmentRec(U(1), "valU", "provider")]);
        expect((await tx.listCommitments()).map((x) => `${x.source}:${x.provider}`).sort()).toEqual(["provider:valU", "user:Sympl", "user:valU"]);
        await tx.replaceCommitments("user", []);
        expect((await tx.listCommitments()).map((x) => x.source)).toEqual(["provider"]);
      });
    });

    it("keeps unlock requests and returns the latest", async () => {
      const c = await make();
      await c.ensureUser(U(1));
      await c.store.run(U(1), async (tx) => {
        await tx.putBudget(budgetRec(U(1)));
        expect(await tx.latestUnlockRequest()).toBeNull();
        await tx.insertUnlockRequest({ id: U(901), userId: U(1), requestedAtMs: T0, unlockAtMs: T0 + 86_400_000 });
        await tx.insertUnlockRequest({ id: U(902), userId: U(1), requestedAtMs: T0 + 5, unlockAtMs: T0 + 86_400_005 });
        expect((await tx.latestUnlockRequest())?.id).toBe(U(902));
      });
    });

    it("deleteAll removes only that user's rows and reports whether anything existed", async () => {
      const c = await make();
      await c.ensureUser(U(1));
      await c.ensureUser(U(2));
      for (const u of [U(1), U(2)]) {
        await c.store.run(u, async (tx) => {
          await tx.putBudget(budgetRec(u));
          await tx.putCycle(cycleRec(u, T0));
          await tx.insertSpendEvent(eventRec(u, "placed:a", T0));
          await tx.replaceCommitments("user", [commitmentRec(u, "valU", "user")]);
          await tx.insertUnlockRequest({ id: u === U(1) ? U(911) : U(912), userId: u, requestedAtMs: T0, unlockAtMs: T0 + 86_400_000 });
        });
      }
      const n = await c.store.run(U(1), (tx) => tx.deleteAll());
      expect(n).toBeGreaterThan(0);
      await c.store.read(U(1), async (tx) => {
        expect(await tx.getBudget()).toBeNull();
        expect(await tx.listCycles(5)).toEqual([]);
        expect(await tx.listSpendEvents(0)).toEqual([]);
        expect(await tx.listCommitments()).toEqual([]);
        expect(await tx.latestUnlockRequest()).toBeNull();
      });
      expect(await c.store.read(U(2), (tx) => tx.getBudget())).not.toBeNull();
      expect(await c.store.run(U(1), (tx) => tx.deleteAll())).toBe(0);
    });

    it("commits events with the state change and discards both on failure", async () => {
      const c = await make();
      await c.ensureUser(U(1));
      await c.store.run(U(1), async (tx) => {
        await tx.putBudget(budgetRec(U(1)));
        await tx.emit([{ type: "budget.set", userId: U(1), capMode: "off", hasCategories: false }]);
      });
      await expect(
        c.store.run(U(1), async (tx) => {
          await tx.insertSpendEvent(eventRec(U(1), "placed:x", T0));
          await tx.emit([{ type: "budget.cycle_rolled", userId: U(1), cycleStartMs: T0 }]);
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(await c.eventTypes()).toEqual(["budget.set"]);
      expect(await c.store.read(U(1), (tx) => tx.listSpendEvents(0))).toEqual([]);
    });

    it("read transactions refuse writes", async () => {
      const c = await make();
      await c.ensureUser(U(1));
      await expect(c.store.read(U(1), (tx) => tx.putBudget(budgetRec(U(1))))).rejects.toThrow();
      expect(await c.store.read(U(1), (tx) => tx.getBudget())).toBeNull();
    });

    it("serializes concurrent runs for one user", async () => {
      const c = await make();
      await c.ensureUser(U(1));
      await c.store.run(U(1), (tx) => tx.putBudget(budgetRec(U(1))));
      await Promise.all(
        Array.from({ length: 12 }, () =>
          c.store.run(U(1), async (tx) => {
            const n = (await tx.listSpendEvents(0)).length;
            await tx.insertSpendEvent(eventRec(U(1), `placed:${n}`, T0 + n));
          }),
        ),
      );
      expect((await c.store.read(U(1), (tx) => tx.listSpendEvents(0))).length).toBe(12);
    });

    it("lists users with a budget by keyset", async () => {
      const c = await make();
      for (const n of [3, 1, 2]) {
        await c.ensureUser(U(n));
        await c.store.run(U(n), (tx) => tx.putBudget(budgetRec(U(n))));
      }
      expect(await c.store.usersWithBudget(null, 2)).toEqual([U(1), U(2)]);
      expect(await c.store.usersWithBudget(U(2), 2)).toEqual([U(3)]);
    });
  });
}
