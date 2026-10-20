import { afterAll, describe, expect, it } from "vitest";
import { KyselyCreatorStore, type CreatorDb } from "./kysely-store";
import { createCreatorDatabase, type PgliteLike } from "../test/pglite-db";
import { U, account, attribution, describeCreatorStoreContract, kyc, link, newCommission } from "../test/repository-contract";

const open: CreatorDb[] = [];
let seq = 0;
const ids = { uuidV7: (): string => `00000000-0000-7000-8000-${String(++seq).padStart(12, "0")}` };

const fresh = async () => {
  const { pg, db } = await createCreatorDatabase();
  open.push(db);
  return {
    pg,
    db,
    store: new KyselyCreatorStore(db, ids),
    ensureUser: async (id: string) => {
      await pg.query(`insert into users (id, status) values ($1, 'active') on conflict do nothing`, [id]);
      await pg.query(
        `insert into creator_terms (version, locale, body, body_sha256) values (1, 'en', 'Creator terms version 1 for tests.', $1) on conflict do nothing`,
        ['0'.repeat(64)],
      );
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

describeCreatorStoreContract("kysely/pglite", fresh);

describe("KyselyCreatorStore specifics", () => {
  const setup = async () => {
    const c = await fresh();
    await c.ensureUser(U(1));
    await c.ensureUser(U(2));
    const a = account(1, U(1));
    await c.store.createAccount(a, kyc(1), []);
    const l = link(1, a.id);
    await c.store.insertLink(l, []);
    await c.store.insertAttribution(attribution(1, a.id, l.id, U(50)), []);
    return { ...c, a, l };
  };
  const asUser = async (pg: PgliteLike, userId: string, stmt: string): Promise<{ rows: unknown[] }> => {
    await pg.exec(`set role app_user; select set_config('app.user_id', '${userId}', false); select set_config('app.role', 'user', false);`);
    try {
      return await pg.query<unknown>(stmt);
    } finally {
      await pg.exec(`reset role`);
    }
  };

  it("schema invariants the adapter relies on", async () => {
    const c = await setup();
    // clawed_back may never exceed amount
    await c.store.claimAccrual({ consumer: "t", messageId: U(2001), commission: newCommission(1, c.a.id, U(401)) });
    await expect(c.pg.query(`update commissions set clawed_back = amount + 1`)).rejects.toThrow();
    // the same order line cannot earn twice for one creator
    await expect(
      c.pg.query(
        `insert into commissions (id, creator_id, order_group_id, order_line_id, base, rate_bps, amount, state, month_key, closed_at, accrued_at)
         select gen_random_uuid(), creator_id, order_group_id, order_line_id, base, rate_bps, amount, state, month_key, closed_at, accrued_at from commissions`,
      ),
    ).rejects.toThrow();
    // a held row needs a reason, a posted state cannot lack the stamp
    await expect(c.pg.query(`update commissions set state = 'ACCRUING', hold_reason = null`)).rejects.toThrow();
    // an under-length slug is refused
    await expect(c.pg.query(`update affiliate_links set slug = 'short'`)).rejects.toThrow();
  });

  it("terms are immutable", async () => {
    const c = await setup();
    await expect(c.pg.query(`update creator_terms set body = 'x' where version = 1`)).rejects.toThrow();
    await expect(c.pg.query(`delete from creator_terms`)).rejects.toThrow();
  });

  it("A-8 guard triggers: postings change only posted_at once, commissions only move forward", async () => {
    const c = await setup();
    const r = await c.store.claimAccrual({ consumer: "t", messageId: U(2001), commission: newCommission(1, c.a.id, U(401)) });
    if (r.kind !== "claimed") throw new Error(r.kind);
    await expect(c.pg.query(`update commission_postings set amount = amount + 1`)).rejects.toThrow();
    await expect(c.pg.query(`delete from commission_postings`)).rejects.toThrow();
    await c.pg.query(`update commission_postings set posted_at = now()`);
    await expect(c.pg.query(`update commission_postings set posted_at = now() + interval '1 day'`)).rejects.toThrow();
    await expect(c.pg.query(`update commissions set base = base + 1`)).rejects.toThrow();
    await expect(c.pg.query(`update commissions set state = 'VOIDED', void_reason = 'x'`)).rejects.toThrow();
    await c.pg.query(`update commissions set clawed_back = 1`);
    await expect(c.pg.query(`update commissions set clawed_back = 0`)).rejects.toThrow();
  });

  it("A-7 an account cannot be created for a terms version that has no stored text", async () => {
    const c = await fresh();
    await c.ensureUser(U(1));
    await c.pg.query(`delete from creator_terms`).catch(() => undefined);
    const a = account(1, U(1), { termsVersion: 99 });
    await expect(c.store.createAccount(a, kyc(1), [])).rejects.toThrow();
  });

  it("A-1 click counters key on device, link and ip; duplicates are detected; minute bucket", async () => {
    const c = await setup();
    const click = (n: number, dev: string, ip: string, at: number) => ({
      id: U(1200 + n), linkId: c.l.id, creatorId: c.a.id, atMs: at, deviceHash: dev.repeat(64), ipHash: ip.repeat(64), counted: true, uaClass: "app" as const,
    });
    const T = Date.UTC(2026, 9, 12, 10, 0, 30);
    await c.store.insertClick(click(1, "a", "1", T), []);
    await c.store.insertClick(click(2, "b", "1", T + 1000), []);
    const r = await c.store.clickCountsSince({
      creatorId: c.a.id, linkId: c.l.id, ipHash: "1".repeat(64), deviceHash: "a".repeat(64),
      hourSinceMs: T - 3_600_000, dedupeSinceMs: T - 60_000, minuteSinceMs: T - 30_000,
    });
    expect(r).toEqual({ ip: 2, device: 1, link: 2, duplicate: true, creatorThisMinute: 2 });
    const other = await c.store.clickCountsSince({
      creatorId: c.a.id, linkId: c.l.id, ipHash: "9".repeat(64), deviceHash: "c".repeat(64),
      hourSinceMs: T - 3_600_000, dedupeSinceMs: T - 60_000, minuteSinceMs: T + 60_000,
    });
    expect(other).toMatchObject({ ip: 0, device: 0, link: 2, duplicate: false, creatorThisMinute: 0 });
  });

  it("A-9 partition maintenance creates upcoming months, drops old partitions and deletes expired rows, idempotently", async () => {
    const c = await setup();
    const now = Date.UTC(2026, 9, 12);
    const old = Date.UTC(2025, 8, 2); // 13+ months before now, inside the 2025-09 range (default partition here)
    await c.store.insertClick(
      { id: U(1300), linkId: c.l.id, creatorId: c.a.id, atMs: old, deviceHash: "a".repeat(64), ipHash: "b".repeat(64), counted: true, uaClass: "app" },
      [],
    );
    await c.pg.exec(`create table affiliate_clicks_2025_01 partition of affiliate_clicks for values from ('2025-01-01') to ('2025-02-01')`);
    const first = await c.store.maintainClickPartitions({ nowMs: now, monthsAhead: 3, retainMonths: 13 });
    expect(first.created).toBeGreaterThanOrEqual(1);
    expect(first.dropped).toBe(1);
    expect(first.deletedRows).toBe(1);
    const second = await c.store.maintainClickPartitions({ nowMs: now, monthsAhead: 3, retainMonths: 13 });
    expect(second).toEqual({ created: 0, dropped: 0, deletedRows: 0 });
    const t = await c.pg.query<{ n: string }>(`select count(*)::text as n from pg_class where relname = 'affiliate_clicks_2027_01'`);
    expect(t.rows[0]?.n).toBe("1");
  });

  it("A-3 a held attribution blocks accrual in the claim transaction and resolves once", async () => {
    const c = await fresh();
    await c.ensureUser(U(1));
    const a = account(1, U(1));
    await c.store.createAccount(a, kyc(1), []);
    const l = link(1, a.id);
    await c.store.insertLink(l, []);
    const held = { ...attribution(1, a.id, l.id, U(50)), status: "HELD" as const, holdReason: "identity_unavailable" as const };
    await c.store.insertAttribution(held, []);
    const r = await c.store.claimAccrual({ consumer: "t", messageId: U(2001), commission: newCommission(1, a.id, held.orderGroupId) });
    expect(r.kind).toBe("attribution_inactive");
    // the inbox row rolled back with the transaction, so redelivery is possible
    expect(await c.store.recordInbox("t", U(2001))).toBe("recorded");
    expect(await c.store.resolveHeldAttribution({ ...held, status: "ACTIVE", holdReason: null }, [])).toBe(true);
    expect(await c.store.resolveHeldAttribution({ ...held, status: "ACTIVE", holdReason: null }, [])).toBe(false);
  });

  it("partitioned clicks accept rows outside the explicit months (default partition)", async () => {
    const c = await setup();
    await c.store.insertClick(
      { id: U(1100), linkId: c.l.id, creatorId: c.a.id, atMs: Date.UTC(2031, 0, 5), deviceHash: "a".repeat(64), ipHash: "b".repeat(64), counted: true, uaClass: "app" },
      [],
    );
    const r = await c.pg.query<{ n: string }>(`select count(*)::text as n from affiliate_clicks`);
    expect(r.rows[0]?.n).toBe("1");
  });

  it("row level security: owner reads own account, commissions and links; others see nothing; no owner writes", async () => {
    const c = await setup();
    await c.store.claimAccrual({ consumer: "t", messageId: U(2001), commission: newCommission(1, c.a.id, U(401)) });
    expect((await asUser(c.pg, U(1), `select id from creator_accounts`)).rows).toHaveLength(1);
    expect((await asUser(c.pg, U(1), `select id from commissions`)).rows).toHaveLength(1);
    expect((await asUser(c.pg, U(1), `select id from affiliate_links`)).rows).toHaveLength(1);
    expect((await asUser(c.pg, U(2), `select id from creator_accounts`)).rows).toHaveLength(0);
    expect((await asUser(c.pg, U(2), `select id from commissions`)).rows).toHaveLength(0);
    expect((await asUser(c.pg, U(2), `select id from affiliate_links`)).rows).toHaveLength(0);
    // KYC, attributions (buyer identity), clicks and postings are never readable by a user role
    expect((await asUser(c.pg, U(1), `select creator_id from creator_kyc`)).rows).toHaveLength(0);
    expect((await asUser(c.pg, U(1), `select order_group_id from attributions`)).rows).toHaveLength(0);
    expect((await asUser(c.pg, U(1), `select commission_id from commission_postings`)).rows).toHaveLength(0);
    const upd = await asUser(c.pg, U(1), `update commissions set amount = amount + 1 returning id`);
    expect(upd.rows).toHaveLength(0);
  });

  it("posting intents are written in the claim transaction and carry the creator user id", async () => {
    const c = await setup();
    await c.store.claimAccrual({ consumer: "t", messageId: U(2001), commission: newCommission(1, c.a.id, U(401)) });
    const r = await c.pg.query<{ seq: number; kind: string; amount: string }>(
      `select seq, kind, amount::text as amount from commission_postings`,
    );
    expect(r.rows).toEqual([{ seq: 0, kind: "accrual", amount: "3000" }]);
    expect((await c.store.listUnpostedIntents(10))[0]?.creatorUserId).toBe(U(1));
  });
});
