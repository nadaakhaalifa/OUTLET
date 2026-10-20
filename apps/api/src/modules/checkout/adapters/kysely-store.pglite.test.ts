import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTestDatabaseUpTo, lintMigration } from "@outlet/db";
import type { PGlite } from "@electric-sql/pglite";
import type { Kysely } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { createPgliteDatabase, type PgliteInstance } from "../../../platform/db";
import { describeSagaRepositoryContract } from "../test/repository-contract";
import { scenarios, sweepKillPoints } from "../test/chaos-scenarios";
import { SHOPPER, T0, U, createWorld } from "../test/world";
import { KyselySagaRepository, type CheckoutDb } from "./kysely-store";

const SQL = readFileSync(
  fileURLToPath(new URL("../../../../../../packages/db/migrations/0033_checkout.sql", import.meta.url)),
  "utf8",
);
const open: Kysely<Record<string, never>>[] = [];

/**
 * 0032 belongs to another module and may not exist yet, so the baseline is migrations 1..31 and this
 * module's own migration is applied on top. Fails loudly if 0033 does not apply cleanly.
 */
const migrated = async (): Promise<PGlite> => {
  const raw = await createTestDatabaseUpTo(31);
  await raw.exec(SQL);
  return raw;
};

const fresh = async () => {
  const raw = await migrated();
  const db: CheckoutDb = createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance);
  open.push(db);
  return {
    raw,
    repo: new KyselySagaRepository(db),
    ensureUser: async (id: string) => {
      await raw.query(`insert into users (id, status) values ($1, 'active') on conflict do nothing`, [id]);
    },
    outboxTypes: async () =>
      (await raw.query<{ t: string }>(`select event_type as t from outbox_events order by occurred_at, id`)).rows.map((r) => r.t),
  };
};

afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

describeSagaRepositoryContract("kysely/pglite", fresh);

describe("0033_checkout", () => {
  it("passes the expand-only migration linter", () => {
    expect(lintMigration(SQL)).toEqual([]);
  });

  it("rolls state and outbox back together when an event is rejected by the database", async () => {
    const c = await fresh();
    await c.ensureUser(U(1));
    const { sagaRecord } = await import("../test/repository-contract");
    const rec = sagaRecord({ orderGroupId: U(200) });
    await c.repo.create(rec, []);
    const next = { ...rec, facts: { ...rec.facts, status: "RESERVE_INVENTORY" as const }, version: 1 };
    const bad = [{ id: U(9000), type: "NOT A VALID TYPE", aggregateId: U(200), occurredAtMs: T0, payload: {} }];
    await expect(c.repo.save(next, 0, bad)).rejects.toThrow();
    const got = await c.repo.get(U(200));
    expect(got?.facts.status).toBe("VALIDATE_CART");
    expect(got?.version).toBe(0);
  });

  it("database invariants: credit + external = total; unknown status refused; payment events immutable and never deleted", async () => {
    const c = await fresh();
    await c.ensureUser(U(1));
    const { sagaRecord } = await import("../test/repository-contract");
    await c.repo.create(sagaRecord({ orderGroupId: U(210) }), []);
    await expect(c.raw.query(`update checkout_sagas set credit_amount = 5 where order_group_id = $1`, [U(210)])).rejects.toThrow();
    await expect(c.raw.query(`update checkout_sagas set status = 'WHATEVER' where order_group_id = $1`, [U(210)])).rejects.toThrow();
    await c.repo.recordPaymentEvent({
      id: U(9100),
      provider: "p",
      eventId: "e",
      orderGroupId: U(210),
      intentId: null,
      kind: "succeeded",
      amount: 1n,
      signatureOk: true,
      rejectReason: null,
      body: "{}",
      receivedAtMs: T0,
    });
    await expect(c.raw.query(`update checkout_payment_events set amount = 2`)).rejects.toThrow(/immutable/);
    await expect(c.raw.query(`delete from checkout_payment_events`)).rejects.toThrow(/never deleted/);
  });

  it("RLS: a customer reads only their own saga and cannot write; the system role writes", async () => {
    const c = await fresh();
    await c.ensureUser(U(1));
    await c.ensureUser(U(2));
    const { sagaRecord } = await import("../test/repository-contract");
    await c.repo.create(sagaRecord({ orderGroupId: U(220), userId: U(1) }), []);
    await c.repo.create(sagaRecord({ orderGroupId: U(221), userId: U(2), cartHash: "other" }), []);
    const as = async <T>(role: string, userId: string, fn: () => Promise<T>): Promise<T> => {
      await c.raw.exec("BEGIN");
      try {
        await c.raw.exec("SET LOCAL ROLE app_user");
        await c.raw.query("select set_config('app.role',$1,true), set_config('app.user_id',$2,true)", [role, userId]);
        const out = await fn();
        await c.raw.exec("COMMIT");
        return out;
      } catch (e) {
        await c.raw.exec("ROLLBACK");
        throw e;
      }
    };
    const count = async () => Number((await c.raw.query<{ n: string }>(`select count(*)::text as n from checkout_sagas`)).rows[0]?.n);
    expect(await as("customer", U(1), count)).toBe(1);
    expect(await as("customer", U(99), count)).toBe(0);
    expect(await as("system", "", count)).toBe(2);
    const upd = await as("customer", U(1), async () =>
      (await c.raw.query(`update checkout_sagas set attempts = 9 where order_group_id = $1 returning 1`, [U(220)])).rows.length,
    );
    expect(upd).toBe(0);
    await expect(
      as("customer", U(1), () =>
        c.raw.query(
          `insert into checkout_payment_events (id, provider, event_id, kind, signature_ok, body) values ($1,'p','x','failed',true,'{}')`,
          [U(9200)],
        ),
      ),
    ).rejects.toThrow();
  });
});

describe("checkout saga on Postgres (PGlite): kill the process at every step", () => {
  it.each(scenarios.map((s) => [s.name, s] as const))(
    "%s: invariants hold at kill points with the real repository, RLS and outbox",
    async (_name, sc) => {
      const template = await migrated();
      await template.query(`insert into users (id, status) values ($1, 'active')`, [SHOPPER]);
      const dbs = new WeakMap<object, CheckoutDb>();
      const make = async () => {
        const raw = await template.clone();
        const db: CheckoutDb = createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance);
        const w = createWorld({ repo: new KyselySagaRepository(db) });
        dbs.set(w, db);
        return w;
      };
      const release = async (w: object): Promise<void> => {
        await dbs.get(w)?.destroy();
      };
      // Every fifth kill point keeps the suite fast; the in-memory sweep covers every point.
      const { points, fired } = await sweepKillPoints(sc, make, 5, release);
      expect(fired).toBeGreaterThanOrEqual(Math.floor(points * 0.15));
      await template.close();
    },
    180_000,
  );
});
