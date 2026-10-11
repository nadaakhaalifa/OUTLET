import { afterAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });
import { KyselyRewardsStore, type RewardsDb } from "./kysely-store";
import { createRewardsDatabase, type PgliteLike } from "../test/pglite-db";
import { U, coin, describeRewardsStoreContract, odds, play, T0 } from "../test/repository-contract";

const open: RewardsDb[] = [];
let seq = 0;
const ids = { uuidV7: (): string => `00000000-0000-7000-8000-${String(++seq).padStart(12, "0")}` };

const fresh = async () => {
  const { pg, db } = await createRewardsDatabase();
  open.push(db);
  return {
    pg,
    db,
    store: new KyselyRewardsStore(db, ids),
    ensureUser: async (id: string) => {
      await pg.query(`insert into users (id, status) values ($1, 'active') on conflict do nothing`, [id]);
    },
    eventTypes: async () => {
      const r = await pg.query<{ event_type: string }>(`select event_type from outbox_events order by id`);
      return r.rows.map((x) => x.event_type);
    },
  };
};

afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

describeRewardsStoreContract("kysely/pglite", fresh);

describe("KyselyRewardsStore specifics", () => {
  it("enforces schema invariants the adapter relies on", async () => {
    const c = await fresh();
    await c.ensureUser(U(1));
    // a clawback must point at a parent and may not move more debt than it claws
    await expect(
      c.store.appendCoinEvent(coin(U(1), { kind: "clawback", amount: -10n, debtDelta: 20n, parentId: null, expiresAtMs: null }), []),
    ).rejects.toThrow();
    // an earn cannot net more than it earns, and must expire
    await expect(c.store.appendCoinEvent(coin(U(1), { amount: 10n, debtDelta: -20n }), [])).rejects.toThrow();
    await expect(c.store.appendCoinEvent(coin(U(1), { expiresAtMs: null }), [])).rejects.toThrow();
    // a positive expire row is refused (expiry never creates coins)
    const lot = coin(U(1));
    await c.store.appendCoinEvent(lot, []);
    await expect(c.store.appendCoinEvent(coin(U(1), { kind: "expire", amount: 5n, parentId: lot.id, expiresAtMs: null }), [])).rejects.toThrow();
  });

  it("no outcome can be cash and a play stores a reproducible audit trail", async () => {
    const c = await fresh();
    await c.ensureUser(U(1));
    const o = odds(1, { effectiveFromMs: T0 });
    await c.store.publishOdds(o, []);
    await expect(
      c.pg.query(
        `insert into game_plays (id, user_id, game, intent_id, day_key, seq, odds_version_id, roll_ppm, outcome_id, outcome_kind, server_seed, server_seed_hash)
         values ($1,$2,'daily_spin','intent-12345678','2027-01-15',1,$3,5,'cash','cash',$4,$4)`,
        ["00000000-0000-7000-8000-0000000fff01", U(1), o.id, "a".repeat(64)],
      ),
    ).rejects.toThrow();
    const p = play(U(1), o.id, { rollPpm: 999_999, serverSeed: "c".repeat(64), serverSeedHash: "d".repeat(64) });
    await c.store.insertPlay(p);
    const back = await c.store.playByIntent(U(1), "daily_spin", p.intentId);
    expect(back).toMatchObject({ rollPpm: 999_999, serverSeed: "c".repeat(64), serverSeedHash: "d".repeat(64), dayKey: "2027-01-15" });
  });

  it("outbox payloads carry ids, enums and integer strings only", async () => {
    const c = await fresh();
    await c.ensureUser(U(1));
    await c.store.appendCoinEvent(coin(U(1), { sourceRef: "o1" }), [
      { type: "coins.earned", userId: U(1), kind: "purchase", coins: 1_000n, sourceRef: "o1", expiresAtMs: T0 },
    ]);
    const rows = await c.pg.query<{ payload: Record<string, unknown> }>(`select payload from outbox_events`);
    expect(rows.rows[0]?.payload).toEqual({ user_id: U(1), kind: "purchase", coins: "1000", source_ref: "o1", expires_at_ms: T0 });
  });

  it("row level security: owners read their coins, others see nothing, users cannot write", async () => {
    const c = await fresh();
    for (const n of [1, 2]) await c.ensureUser(U(n));
    await c.store.appendCoinEvent(coin(U(1), { sourceRef: "rls1" }), []);
    const pg: PgliteLike = c.pg;
    const asUser = async (userId: string, stmt: string): Promise<{ rows: unknown[] }> => {
      await pg.exec(`set role app_user; select set_config('app.user_id', '${userId}', false); select set_config('app.role', 'user', false);`);
      try {
        return await pg.query(stmt);
      } finally {
        await pg.exec(`reset role`);
      }
    };
    expect((await asUser(U(1), `select id from coin_events`)).rows).toHaveLength(1);
    expect((await asUser(U(2), `select id from coin_events`)).rows).toHaveLength(0);
    await expect(
      asUser(
        U(1),
        `insert into coin_events (id, user_id, kind, amount, source_ref, expires_at, piastres_per_coin, config_version)
         values ('${U(900)}', '${U(1)}', 'game', 99999, 'forged', now(), 1, 1)`,
      ),
    ).rejects.toThrow();
    // odds are public
    const o = odds(1, { effectiveFromMs: T0 });
    await c.store.publishOdds(o, []);
    expect((await asUser(U(2), `select id from game_odds_versions`)).rows).toHaveLength(1);
  });
});
