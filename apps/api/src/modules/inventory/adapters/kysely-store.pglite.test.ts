import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintMigration } from "@outlet/db";
import { DEFAULT_TTL_POLICIES, POOL_CAP, type ReservePlan, type SyncCommand } from "../domain/core";
import { FAWRY_POOL_ID, InMemoryInventoryStore, STANDARD_POOL_ID } from "./in-memory";
import { KyselyInventoryStore, LevelBackedSkuDirectory, type InventoryDb } from "./kysely-store";
import { createInventoryDatabase, migrationSql, type PgliteLike } from "../test/pglite-db";
import { LOC_A, SKU_A1, SKU_A2, STORE_A, STORE_B, U, USER_1 } from "../test/fixtures";

/**
 * Runs the migration 0016 functions on PGlite. PGlite is ONE backend, so this file proves the
 * single-session semantics (all-or-nothing, idempotency, version guards, RLS, append-only) and
 * cannot prove SKIP LOCKED behaviour under concurrent sessions: that is
 * tooling/db/inventory-concurrency.sh against real PostgreSQL 16.
 */
let pg: PgliteLike;
let db: InventoryDb;
let store: KyselyInventoryStore;
let seq = 0;
const NOW = 1_800_000_000_000;

const count = async (table: string, where = "true"): Promise<number> => {
  const r = await pg.query<{ n: number }>(`select count(*)::int as n from ${table} where ${where}`);
  return r.rows[0]?.n ?? -1;
};

const plan = (lines: { sku: string; qty: number; pool?: string }[], opts: Partial<ReservePlan> = {}): ReservePlan => {
  const ls = lines
    .map((l) => ({ skuId: l.sku, locationId: LOC_A, poolId: l.pool ?? STANDARD_POOL_ID, storeId: STORE_A, qty: l.qty }))
    .sort((a, b) => (a.skuId < b.skuId ? -1 : 1));
  return {
    lines: ls,
    ttlSeconds: 600,
    ttlPolicyId: DEFAULT_TTL_POLICIES[0]?.id ?? "",
    poolKind: "STANDARD",
    holdReason: "CARD_WINDOW",
    fingerprint: ls.map((l) => `${l.skuId}:${l.locationId}:${l.poolId}:${l.qty}`).join(","),
    ...opts,
  };
};

const sync = (sku: string, mode: "set" | "adjust", quantity: number, key: string, extra: Partial<SyncCommand> = {}) =>
  store.applySync({
    skuId: sku, locationId: LOC_A, poolId: STANDARD_POOL_ID, storeId: STORE_A, mode, quantity, reason: "received",
    idempotencyKey: key, actorType: "seller", actorId: "seller-1", nowMs: NOW, ...extra,
  });

const reserve = (og: number, p: ReservePlan, nowMs = NOW) =>
  store.reserve({ reservationId: U(0x40000 + (seq += 1)), orderGroupId: U(0x8000 + og), userId: USER_1, plan: p, nowMs });

beforeAll(async () => {
  ({ pg, db } = await createInventoryDatabase());
  store = new KyselyInventoryStore(db);
  await pg.exec(`insert into users (id, status) values ('${USER_1}', 'active')`);
  await pg.exec(`insert into locations (id, store_id, kind, name) values ('${LOC_A}', '${STORE_A}', 'SELLER_WAREHOUSE', 'A main')`);
}, 60_000);
afterAll(async () => {
  await db.destroy(); // closes the PGlite instance through the dialect
});

describe("migration 0016", () => {
  it("passes the expand-only migration linter", () => {
    expect(lintMigration(migrationSql("0016_inventory.sql"))).toEqual([]);
  });

  it("seeds the pools and the ADR-0011 policies with the same ids and values as the domain defaults", async () => {
    const pools = await pg.query<{ id: string; kind: string }>("select id::text, kind from stock_pools order by kind");
    expect(pools.rows).toEqual([
      { id: FAWRY_POOL_ID, kind: "FAWRY" },
      { id: STANDARD_POOL_ID, kind: "STANDARD" },
    ]);
    const policies = await store.ttlPolicies(NOW);
    const byMethod = (xs: readonly { paymentMethod: string }[]) => [...xs].sort((a, b) => (a.paymentMethod < b.paymentMethod ? -1 : 1));
    expect(byMethod(policies)).toEqual(byMethod(DEFAULT_TTL_POLICIES));
  });

  it("enables RLS on every new table", async () => {
    const r = await pg.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class where relname in
       ('locations','stock_pools','inventory_levels','inventory_units','reservation_ttl_policies','reservations',
        'reservation_lines','inventory_adjustments','inventory_oversell_events') order by relname`,
    );
    expect(r.rows).toHaveLength(9);
    expect(r.rows.every((x) => x.relrowsecurity)).toBe(true);
  });
});

describe("stock sync", () => {
  it("creates a level, materialises the pool and is idempotent by key", async () => {
    const a = await sync(SKU_A1, "set", 5, "k-a1-1");
    expect(a).toMatchObject({ status: "applied", replayed: false, level: { onHand: 5, available: 5, syncVersion: 1 } });
    expect(await count("inventory_units", `sku_id = '${SKU_A1}' and state = 'AVAILABLE'`)).toBe(5);
    const again = await sync(SKU_A1, "set", 5, "k-a1-1");
    expect(again).toMatchObject({ status: "applied", replayed: true, level: { onHand: 5, syncVersion: 1 } });
    expect(await count("inventory_adjustments", `sku_id = '${SKU_A1}'`)).toBe(1);
  });

  it("guards versions and negatives", async () => {
    expect(await sync(SKU_A1, "set", 9, "k-a1-2", { expectedVersion: 0 })).toEqual({ status: "version_conflict", currentVersion: 1 });
    expect(await sync(SKU_A1, "adjust", -6, "k-a1-3")).toEqual({ status: "negative", wouldBe: -1 });
    expect(await sync(SKU_A1, "set", 6, "k-a1-4", { sourceVersion: 7 })).toMatchObject({ status: "applied", level: { onHand: 6, syncVersion: 2 } });
    expect(await sync(SKU_A1, "set", 1, "k-a1-5", { sourceVersion: 7 })).toEqual({ status: "stale", currentSourceVersion: 7 });
  });

  it("refuses a SKU that belongs to another store", async () => {
    await expect(
      store.applySync({
        skuId: SKU_A1, locationId: LOC_A, poolId: STANDARD_POOL_ID, storeId: STORE_B, mode: "set", quantity: 1,
        reason: "other", idempotencyKey: "evil", actorType: "seller", actorId: "b", nowMs: NOW,
      }),
    ).rejects.toThrow(/store mismatch/);
  });

  it("caps the materialised pool at 1000 rows", async () => {
    const r = await sync(SKU_A2, "set", 1500, "k-a2-1");
    expect(r).toMatchObject({ status: "applied", level: { onHand: 1500, available: 1500 } });
    expect(await count("inventory_units", `sku_id = '${SKU_A2}' and state = 'AVAILABLE'`)).toBe(POOL_CAP);
    await sync(SKU_A2, "set", 10, "k-a2-2");
    expect(await count("inventory_units", `sku_id = '${SKU_A2}' and state = 'AVAILABLE'`)).toBe(10);
  });

  it("adjustments are append-only", async () => {
    await expect(pg.exec("update inventory_adjustments set delta = 0")).rejects.toThrow(/append-only/);
    await expect(pg.exec("delete from inventory_adjustments")).rejects.toThrow(/append-only/);
  });
});

const sku = (n: number): string => U(0x300 + n);

describe("reserve, claim, release, sweep", () => {
  it("all-or-nothing across SKUs, and a failed attempt leaves no reservation behind", async () => {
    await sync(sku(1), "set", 3, "k-r-1");
    await sync(sku(2), "set", 1, "k-r-2");
    const before = await count("reservations");
    const r = await reserve(1, plan([{ sku: sku(1), qty: 2 }, { sku: sku(2), qty: 2 }]));
    expect(r).toEqual({
      status: "insufficient",
      shortfalls: [{ skuId: sku(2), locationId: LOC_A, requested: 2, available: 1 }],
    });
    expect(await count("reservations")).toBe(before);
    expect(await count("inventory_units", `state = 'RESERVED' and sku_id in ('${sku(1)}','${sku(2)}')`)).toBe(0);
    const ok = await reserve(1, plan([{ sku: sku(1), qty: 2 }, { sku: sku(2), qty: 1 }]));
    expect(ok.status).toBe("reserved");
  });

  it("is idempotent per order group and flags different lines as a conflict", async () => {
    const p = plan([{ sku: sku(1), qty: 2 }, { sku: sku(2), qty: 1 }]);
    expect(await reserve(1, p)).toMatchObject({ status: "reserved", replayed: true });
    expect(await reserve(1, plan([{ sku: sku(1), qty: 1 }]))).toEqual({ status: "conflict" });
  });

  it("claims atomically with its outbox rows and commits stock", async () => {
    expect(await store.claim(U(0x8001), NOW)).toEqual({ status: "claimed" });
    expect(await store.claim(U(0x8001), NOW)).toEqual({ status: "already_claimed" });
    expect(await store.claim(U(0x8fff), NOW)).toEqual({ status: "not_found" });
    expect(await store.levelView(sku(1), LOC_A, STANDARD_POOL_ID)).toMatchObject({ onHand: 3, committed: 2, reserved: 0, available: 1 });
    expect(await count("outbox_events", "event_type = 'inventory.claimed'")).toBe(2);
    expect(await count("outbox_events", "event_type = 'inventory.reserved'")).toBe(2);
  });

  it("sweeps expired reservations back to the pool, and a late payment claims from free stock", async () => {
    await sync(sku(3), "set", 4, "k-sw-1");
    const p = plan([{ sku: sku(3), qty: 4 }]);
    expect((await reserve(2, p)).status).toBe("reserved");
    expect(await store.sweepExpired(NOW + 599_000, 500)).toEqual({ expiredReservations: 0, releasedUnits: 0 });
    expect(await store.sweepExpired(NOW + 600_000, 500)).toEqual({ expiredReservations: 1, releasedUnits: 4 });
    expect(await store.levelView(sku(3), LOC_A, STANDARD_POOL_ID)).toMatchObject({ reserved: 0, available: 4 });
    expect(await reserve(2, p)).toEqual({ status: "closed", reservationStatus: "EXPIRED" });
    expect(await store.claim(U(0x8002), NOW + 700_000)).toEqual({ status: "claimed_late" });
    expect(await store.levelView(sku(3), LOC_A, STANDARD_POOL_ID)).toMatchObject({ committed: 4, available: 0 });
  });

  it("late claim reports unavailable when the stock is gone, and leaves the reservation EXPIRED", async () => {
    await sync(sku(4), "set", 1, "k-late-1");
    const p = plan([{ sku: sku(4), qty: 1 }]);
    expect((await reserve(3, p)).status).toBe("reserved");
    await store.sweepExpired(NOW + 2_000_000, 500);
    expect((await reserve(4, p)).status).toBe("reserved");
    expect(await store.claim(U(0x8004), NOW + 2_000_001)).toEqual({ status: "claimed" });
    expect(await store.claim(U(0x8003), NOW + 2_000_002)).toMatchObject({ status: "unavailable" });
    expect(await count("reservations", `order_group_id = '${U(0x8003)}' and status = 'EXPIRED'`)).toBe(1);
  });

  it("release is idempotent and never touches claimed stock", async () => {
    await sync(sku(5), "set", 5, "k-rel-1");
    const p = plan([{ sku: sku(5), qty: 2 }]);
    expect((await reserve(5, p)).status).toBe("reserved");
    expect(await store.release(U(0x8005), "payment_failed", NOW)).toEqual({ status: "released" });
    expect(await store.release(U(0x8005), "payment_failed", NOW)).toEqual({ status: "noop", reservationStatus: "RELEASED" });
    expect(await store.release(U(0x8ffe), "cancelled", NOW)).toEqual({ status: "not_found" });
    expect(await store.levelView(sku(5), LOC_A, STANDARD_POOL_ID)).toMatchObject({ reserved: 0, available: 5 });
  });

  it("inline replenish serves a reserve even when the pool was never materialised", async () => {
    await sync(sku(6), "set", 5, "k-inl-1");
    await pg.exec(`delete from inventory_units where sku_id = '${sku(6)}' and state = 'AVAILABLE'`);
    expect(await count("inventory_units", `sku_id = '${sku(6)}' and state = 'AVAILABLE'`)).toBe(0);
    const r = await reserve(6, plan([{ sku: sku(6), qty: 3 }]));
    expect(r.status).toBe("reserved");
    expect(await store.levelView(sku(6), LOC_A, STANDARD_POOL_ID)).toMatchObject({ reserved: 3, available: 2 });
  });

  it("replenish_due repairs a drifted pool", async () => {
    await pg.exec(`delete from inventory_units where sku_id = '${sku(6)}' and state = 'AVAILABLE'`);
    expect(await store.replenishDue(50)).toBeGreaterThanOrEqual(1);
    expect(await count("inventory_units", `sku_id = '${sku(6)}' and state = 'AVAILABLE'`)).toBe(2);
  });
});

describe("oversell penalty and Fawry pool", () => {
  it("honours reserved orders on a decrease and records the shortfall", async () => {
    await sync(sku(7), "set", 10, "k-ov-1");
    expect((await reserve(7, plan([{ sku: sku(7), qty: 4 }]))).status).toBe("reserved");
    const r = await sync(sku(7), "set", 1, "k-ov-2", { reason: "damaged" });
    expect(r).toMatchObject({ status: "applied", oversoldUnits: 3, level: { onHand: 1, reserved: 4, available: 0 } });
    const ev = await pg.query<{ shortfall_units: number; reason_detail: string }>(
      `select shortfall_units, reason_detail from inventory_oversell_events where sku_id = '${sku(7)}'`,
    );
    expect(ev.rows).toEqual([{ shortfall_units: 3, reason_detail: "damaged" }]);
    expect(await count("outbox_events", `event_type = 'inventory.oversold' and aggregate_id = '${sku(7)}'`)).toBe(1);
    // the pool never offers more than free stock, and the held order is still honoured
    expect(await count("inventory_units", `sku_id = '${sku(7)}' and state = 'AVAILABLE'`)).toBe(0);
    expect(await store.claim(U(0x8007), NOW)).toEqual({ status: "claimed" });
  });

  it("moves stock to the Fawry pool and Fawry holds never touch STANDARD", async () => {
    await sync(sku(8), "set", 20, "k-f-1");
    const base = { skuId: sku(8), locationId: LOC_A, fromPoolId: STANDARD_POOL_ID, toPoolId: FAWRY_POOL_ID, storeId: STORE_A, nowMs: NOW };
    expect(await store.transfer({ ...base, qty: 21, idempotencyKey: "t-0" })).toMatchObject({ status: "insufficient" });
    expect(await store.transfer({ ...base, qty: 3, idempotencyKey: "t-1" })).toEqual({ status: "transferred", replayed: false });
    expect(await store.transfer({ ...base, qty: 3, idempotencyKey: "t-1" })).toEqual({ status: "transferred", replayed: true });
    const fawryPlan = plan([{ sku: sku(8), qty: 2, pool: FAWRY_POOL_ID }], { ttlSeconds: 86_400, poolKind: "FAWRY", holdReason: "FAWRY_WINDOW" });
    expect((await reserve(8, fawryPlan)).status).toBe("reserved");
    expect(await store.levelView(sku(8), LOC_A, FAWRY_POOL_ID)).toMatchObject({ onHand: 3, reserved: 2, available: 1 });
    expect(await store.levelView(sku(8), LOC_A, STANDARD_POOL_ID)).toMatchObject({ onHand: 17 });
  });

  it("LevelBackedSkuDirectory finds owner and location from the level", async () => {
    const dir = new LevelBackedSkuDirectory(db);
    expect(await dir.lookup(sku(8))).toEqual({ storeId: STORE_A, locationId: LOC_A, dropId: null });
    expect(await dir.lookup(U(0xdead))).toBeNull();
  });
});

describe("row level security", () => {
  const asRole = async (role: string, storeIds: string, run: () => Promise<number>): Promise<number> => {
    await pg.exec(`begin; set local role app_user; select set_config('app.role','${role}',true), set_config('app.store_ids','${storeIds}',true), set_config('app.user_id','',true)`);
    try {
      return await run();
    } finally {
      await pg.exec("rollback");
    }
  };
  const levels = async (): Promise<number> => (await pg.query<{ n: number }>("select count(*)::int as n from inventory_levels")).rows[0]?.n ?? -1;

  it("hides levels from other stores and from shoppers, shows the owner their own", async () => {
    expect(await asRole("seller", STORE_A, levels)).toBeGreaterThan(0);
    expect(await asRole("seller", STORE_B, levels)).toBe(0);
    expect(await asRole("customer", "", levels)).toBe(0);
    expect(await asRole("system", "", levels)).toBeGreaterThan(0);
  });

  it("a seller cannot write units or reservations directly", async () => {
    const writeUnit = async (): Promise<number> => {
      await pg.exec("savepoint s");
      try {
        await pg.exec(`update inventory_units set state = 'AVAILABLE' where sku_id = '${SKU_A1}'`);
        return (await pg.query<{ n: number }>(`select count(*)::int as n from inventory_units where state='AVAILABLE' and sku_id='${SKU_A1}'`)).rows[0]?.n ?? -1;
      } finally {
        await pg.exec("rollback to savepoint s");
      }
    };
    // RLS UPDATE with a failing USING silently affects 0 rows; the count of AVAILABLE rows must be unchanged.
    const before = await count("inventory_units", `state = 'AVAILABLE' and sku_id = '${SKU_A1}'`);
    const after = await asRole("seller", STORE_A, writeUnit);
    expect(after).toBe(before);
    await expect(
      asRole("seller", STORE_A, async () => {
        await pg.exec(`insert into reservations (id, order_group_id, user_id, hold_reason, ttl_policy_id, expires_at, lines_fingerprint, created_at)
                       values ('${U(0xfeed)}', '${U(0xfeee)}', '${USER_1}', 'COD', '${DEFAULT_TTL_POLICIES[0]?.id}', now(), 'x', now())`);
        return 0;
      }),
    ).rejects.toThrow(/row-level security/);
  });
});

describe("differential: SQL functions agree with the reference model", () => {
  it.each([123456789, 987654321, 424242])("returns the same outcomes and levels for 200 seeded operations (seed %i)", async (seed) => {
    // fresh SKUs so earlier state does not interfere
    const S1 = U(0x2a1);
    const S2 = U(0x2a2);
    let rng = seed;
    const rnd = (n: number): number => {
      rng = (rng * 1103515245 + 12345) & 0x7fffffff;
      return (rng >>> 8) % n;
    };
    let uid = 0x70000;
    const mem = new InMemoryInventoryStore(() => U((uid += 1)));
    // own database: sweeping must not see other tests' reservations
    const fresh = await createInventoryDatabase();
    await fresh.pg.exec(`insert into users (id, status) values ('${USER_1}', 'active')`);
    await fresh.pg.exec(`insert into locations (id, store_id, kind, name) values ('${LOC_A}', '${STORE_A}', 'SELLER_WAREHOUSE', 'A')`);
    const sqlStore = new KyselyInventoryStore(fresh.db);
    let now = NOW + 10_000_000;
    const stores = [mem, sqlStore] as const;
    const tally = new Map<string, number>();
    const strip = (o: unknown): unknown => JSON.parse(JSON.stringify(o, (k, v: unknown) => (k === "reservationId" ? "R" : v)));

    for (let i = 0; i < 200; i += 1) {
      const op = rnd(9);
      now += rnd(3) === 0 ? 700_000 : 1_000;
      const sku = rnd(2) === 0 ? S1 : S2;
      const og = U(0xa000 + rnd(12));
      const mode = rnd(3) === 0 ? ("adjust" as const) : ("set" as const);
      const qty = rnd(6);
      const fawry = rnd(5) === 0;
      const lineQty = 1 + rnd(3);
      const results: unknown[] = [];
      for (const s of stores) {
        if (op <= 1) {
          results.push(
            strip(
              await s.applySync({
                skuId: sku, locationId: LOC_A, poolId: STANDARD_POOL_ID, storeId: STORE_A,
                mode, quantity: mode === "adjust" ? qty - 2 : qty + 1, reason: "recount",
                idempotencyKey: `d-${i}`, actorType: "seller", actorId: "x", nowMs: now,
              }),
            ),
          );
        } else if (op <= 4) {
          const pool = fawry ? FAWRY_POOL_ID : STANDARD_POOL_ID;
          const p = plan(
            [{ sku, qty: lineQty, pool }],
            fawry ? { ttlSeconds: 86_400, poolKind: "FAWRY", holdReason: "FAWRY_WINDOW" } : {},
          );
          results.push(strip(await s.reserve({ reservationId: U(0x60000 + i), orderGroupId: og, userId: USER_1, plan: p, nowMs: now })));
        } else if (op <= 6) {
          results.push(strip(await s.claim(og, now)));
        } else if (op === 7) {
          results.push(strip(await s.release(og, "cancelled", now)));
        } else {
          results.push(strip(await s.sweepExpired(now, 500)));
        }
      }
      // reserve expiresAt must match too (same clock), claim/release/sweep must match exactly
      expect(results[1], `op ${i} kind ${op}`).toEqual(results[0]);
      const st = (results[0] as { status?: string } | undefined)?.status ?? "sweep";
      tally.set(st, (tally.get(st) ?? 0) + 1);
      for (const pool of [STANDARD_POOL_ID, FAWRY_POOL_ID]) {
        for (const k of [S1, S2]) {
          const a = await mem.levelView(k, LOC_A, pool);
          const b = await sqlStore.levelView(k, LOC_A, pool);
          const pick = (v: typeof a) => (v === null ? null : { onHand: v.onHand, committed: v.committed, reserved: v.reserved, available: v.available, syncVersion: v.syncVersion });
          expect(pick(b), `level ${k} ${pool} after op ${i}`).toEqual(pick(a));
        }
      }
    }
    // the sequence must have exercised the interesting branches, not just no-ops
    for (const status of ["applied", "reserved", "claimed"]) {
      expect(tally.get(status) ?? 0, `status ${status} never occurred: ${JSON.stringify([...tally])}`).toBeGreaterThan(0);
    }
    // global SQL invariant: pool rows never exceed free stock
    const bad = await fresh.pg.query<{ n: number }>(`
      select count(*)::int as n from inventory_levels l
       where (select count(*) from inventory_units u where u.sku_id = l.sku_id and u.location_id = l.location_id
                 and u.pool_id = l.pool_id and u.state = 'AVAILABLE')
             > greatest(0, l.on_hand - l.committed
                 - (select count(*) from inventory_units u where u.sku_id = l.sku_id and u.location_id = l.location_id
                       and u.pool_id = l.pool_id and u.state = 'RESERVED'))
          or (select count(*) from inventory_units u where u.sku_id = l.sku_id and u.location_id = l.location_id
                 and u.pool_id = l.pool_id and u.state = 'CLAIMED') <> l.committed`);
    expect(bad.rows[0]?.n).toBe(0);
    await fresh.db.destroy();
  }, 120_000);
});
