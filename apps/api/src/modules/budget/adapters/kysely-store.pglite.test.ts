import { afterAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import { KyselyBudgetStore, type BudgetDb } from "./kysely-store";
import { createBudgetDatabase, type PgliteLike } from "../test/pglite-db";
import { U, budgetRec, cycleRec, describeBudgetStoreContract, eventRec } from "../test/repository-contract";

const open: BudgetDb[] = [];
let seq = 0;
const ids = { uuidV7: (): string => `00000000-0000-7000-8000-${String(++seq).padStart(12, "0")}` };

/** One migrated database per file (migrations take seconds); every call resets all budget state. */
let shared: Promise<{ pg: PgliteLike; db: BudgetDb }> | null = null;
const fresh = async () => {
  shared ??= createBudgetDatabase();
  const { pg, db } = await shared;
  if (!open.includes(db)) open.push(db);
  await pg.exec(`delete from users;`);
  // the outbox is append-only: count what exists now and report only newer rows
  const baseline = Number((await pg.query<{ n: string }>(`select count(*)::text as n from outbox_events`)).rows[0]?.n ?? 0);
  return {
    pg,
    db,
    baseline,
    store: new KyselyBudgetStore(db, ids),
    ensureUser: async (id: string) => {
      await pg.query(`insert into users (id, status) values ($1, 'active') on conflict do nothing`, [id]);
    },
    eventTypes: async () => {
      const r = await pg.query<{ event_type: string }>(`select event_type from outbox_events order by id`);
      return r.rows.map((x) => x.event_type).slice(baseline);
    },
  };
};

afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

describeBudgetStoreContract("kysely/pglite", fresh);

describe("KyselyBudgetStore specifics", () => {
  it("row level security: each user sees only their own rows, other roles see nothing without a user id", async () => {
    const c = await fresh();
    for (const n of [1, 2]) {
      await c.ensureUser(U(n));
      await c.store.run(U(n), async (tx) => {
        await tx.putBudget(budgetRec(U(n)));
        await tx.putCycle(cycleRec(U(n), 1_800_000_000_000));
        await tx.insertSpendEvent(eventRec(U(n), "placed:a", 1_800_000_000_000));
      });
    }
    const pg: PgliteLike = c.pg;
    const asUser = async (userId: string | null, stmt: string): Promise<{ rows: unknown[] }> => {
      await pg.exec(
        `set role app_user; select set_config('app.user_id', '${userId ?? ""}', false); select set_config('app.role', 'user', false);`,
      );
      try {
        return await pg.query(stmt);
      } finally {
        await pg.exec(`reset role`);
      }
    };
    for (const table of ["budgets", "budget_cycles", "budget_spend_events"]) {
      expect((await asUser(U(1), `select user_id from ${table}`)).rows).toHaveLength(1);
      expect((await asUser(null, `select user_id from ${table}`)).rows).toHaveLength(0);
    }
    expect((await asUser(U(2), `update budgets set payday = 1 where user_id = '${U(1)}' returning user_id`)).rows).toHaveLength(0);
    await expect(
      asUser(U(2), `insert into budget_spend_events (user_id, event_key, kind, order_placed_at, occurred_at, detail) values ('${U(2)}','x','placed',now(),now(),'\\x00')`),
    ).rejects.toThrow();
  });

  it("outbox payloads carry ids and enums only, never an amount", async () => {
    const c = await fresh();
    await c.ensureUser(U(1));
    await c.store.run(U(1), async (tx) => {
      await tx.putBudget(budgetRec(U(1), { amountEnc: new TextEncoder().encode("1234567") }));
      await tx.emit([
        { type: "budget.set", userId: U(1), capMode: "hard", hasCategories: true },
        { type: "budget.cap_unlock_requested", userId: U(1), unlockAtMs: 1_800_086_400_000 },
      ]);
    });
    const rows = await c.pg.query<{ payload: Record<string, unknown> }>(`select payload from outbox_events order by id offset ${c.baseline}`);
    expect(rows.rows).toHaveLength(2);
    for (const r of rows.rows) expect(Object.keys(r.payload).every((k) => !/amount|spent|monthly|budget_amount/.test(k))).toBe(true);
    expect(JSON.stringify(rows.rows)).not.toContain("1234567");
  });

  it("the READ ONLY transaction is enforced by the database, not only by the adapter", async () => {
    const c = await fresh();
    await c.ensureUser(U(1));
    await expect(c.store.read(U(1), (tx) => tx.putBudget(budgetRec(U(1))))).rejects.toThrow(/read-only transaction/);
  });
});
