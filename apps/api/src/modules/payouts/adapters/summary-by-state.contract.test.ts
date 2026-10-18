import { afterAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { createPgliteDatabase, type PgliteInstance } from "../../../platform/db";
import { PAYOUT_STATES } from "../domain/bridge";
import type { PayoutStore } from "../domain/ports";
import { PayoutSummaryQuery } from "../application/queries";
import { createPayoutsDatabase, pinUpdatedAt } from "../test/db";
import { DEFAULT_PAYOUT_CONFIG } from "../application/commands";
import { FINANCE_1, STORE_A, STORE_B, T0, TestClock, addOrder, kit, seedStore } from "../test/fixtures";
import { InMemoryPayoutStore } from "./in-memory";
import { KyselyPayoutStore, type PayoutsDb } from "./kysely-store";

const open: Kysely<Record<string, never>>[] = [];
afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

async function makeKysely(): Promise<{ store: PayoutStore; clock: TestClock; ensureUser: (id: string) => Promise<void> }> {
  const raw = await createPayoutsDatabase();
  const db: PayoutsDb = createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance);
  open.push(db);
  await pinUpdatedAt(raw, T0);
  const clock = new TestClock(T0);
  return {
    store: new KyselyPayoutStore(db, clock),
    clock,
    ensureUser: async (id) => {
      await raw.query(`insert into users (id, status) values ($1, 'active') on conflict do nothing`, [id]);
    },
  };
}
async function makeMemory() {
  const clock = new TestClock();
  return { store: new InMemoryPayoutStore(clock), clock, ensureUser: async () => undefined };
}

describe.each([
  ["in-memory", makeMemory],
  ["kysely/pglite", makeKysely],
])("PayoutStore.summaryByState (%s)", (_name, make) => {
  it("agrees with a row walk: counts and amounts per state, hold reasons sum to the count", async () => {
    const c = await make();
    await c.ensureUser(FINANCE_1);
    const k = kit(c.store, c.clock);
    seedStore(k, STORE_A);
    seedStore(k, STORE_B, { legalName: "Delta Wear", holder: "Delta Wear" });
    addOrder(k, 1, 80_000n);
    addOrder(k, 2, 70_000n, { storeId: STORE_B });
    addOrder(k, 3, 5_000_000_000_000n, { storeId: STORE_B });
    await k.commands.schedule();
    const rows = (await c.store.list({ scope: { kind: "system" }, after: null, limit: 50 })).items;
    const first = rows[0];
    if (first === undefined) throw new Error("no payout");
    await k.commands.hold({ payoutId: first.id, actor: { id: FINANCE_1 }, key: "0192f3a4-5b6c-7d8e-9f01-000000000777" });

    const q = new PayoutSummaryQuery(c.store, DEFAULT_PAYOUT_CONFIG.cycle);
    const now = c.clock.nowMs();
    const s = await q.execute({ scope: { kind: "staff", userId: FINANCE_1, role: "finance" }, nowMs: now });
    const after = (await c.store.list({ scope: { kind: "system" }, after: null, limit: 50 })).items;
    let count = 0;
    let amount = 0n;
    for (const st of PAYOUT_STATES) {
      const mine = after.filter((p) => p.status === st);
      expect(s.byState[st].count).toBe(mine.length);
      expect(s.byState[st].amount).toBe(mine.reduce((a, p) => a + p.amount, 0n));
      count += s.byState[st].count;
      amount += s.byState[st].amount;
    }
    expect(count).toBe(after.length);
    expect(amount).toBe(after.reduce((a, p) => a + p.amount, 0n));
    const hold = s.byState.ON_HOLD;
    expect(hold.count).toBe(after.filter((p) => p.status === "ON_HOLD").length);
    expect(hold.count).toBeGreaterThanOrEqual(1);
    expect(Object.values(hold.byHoldReason ?? {}).reduce((a, b) => a + b, 0)).toBe(hold.count);
    expect(hold.oldestUpdatedAtMs).not.toBeNull();
    expect(s.nextCycleAtMs).toBeGreaterThan(now);
  });

  it("does not let a seller scope read the summary totals of other stores", async () => {
    const c = await make();
    const k = kit(c.store, c.clock);
    seedStore(k, STORE_A);
    seedStore(k, STORE_B, { legalName: "Delta Wear", holder: "Delta Wear" });
    addOrder(k, 1, 80_000n);
    addOrder(k, 2, 70_000n, { storeId: STORE_B });
    await k.commands.schedule();
    const own = await c.store.summaryByState({ kind: "seller", userId: FINANCE_1, storeIds: [STORE_A] }, 0);
    expect(own.SCHEDULED?.count).toBe(1);
  });
});
