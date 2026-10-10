import { afterAll, describe, expect, it } from "vitest";
import { KyselyReferralStore, type ReferralDb } from "./kysely-store";
import { createReferralDatabase, type PgliteLike } from "../test/pglite-db";
import { describeReferralStoreContract, referral, U } from "../test/repository-contract";

const open: ReferralDb[] = [];
let seq = 0;
const ids = { uuidV7: (): string => `00000000-0000-7000-8000-${String(++seq).padStart(12, "0")}` };

const fresh = async () => {
  const { pg, db } = await createReferralDatabase();
  open.push(db);
  return {
    pg,
    db,
    store: new KyselyReferralStore(db, ids),
    ensureUser: async (id: string) => {
      await pg.query(`insert into users (id, status) values ($1, 'active') on conflict do nothing`, [id]);
    },
    eventTypes: async () => {
      const r = await pg.query<{ event_type: string }>(`select event_type from outbox_events order by id`);
      return r.rows.map((x) => x.event_type);
    },
    rewardEventAmounts: async () => {
      const r = await pg.query<{ a: string }>(
        `select payload->>'amount' as a from outbox_events where event_type = 'referral.reward_earned' order by id`,
      );
      return r.rows.map((x) => x.a);
    },
  };
};

afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

describeReferralStoreContract("kysely/pglite", fresh);

describe("KyselyReferralStore specifics", () => {
  it("enforces schema invariants the adapter relies on", async () => {
    const c = await fresh();
    await c.ensureUser(U(1));
    await c.ensureUser(U(2));
    await c.store.ensureCode({ id: U(101), ownerUserId: U(1), code: "ABCDEFGH", nowMs: 1_800_000_000_000 });
    // a non-rejected self referral is refused by CHECK
    await expect(c.store.insertAttribution(referral(1, U(1), U(1), U(101)), [])).rejects.toThrow();
    // invalid code alphabet is refused by CHECK (I, L, O, U are excluded)
    await expect(
      c.store.ensureCode({ id: U(102), ownerUserId: U(2), code: "ABCDEFGI", nowMs: 1_800_000_000_000 }),
    ).rejects.toThrow();
  });

  it("row level security: a user sees only referrals they are party to, and cannot update", async () => {
    const c = await fresh();
    for (const n of [1, 2, 3]) await c.ensureUser(U(n));
    await c.store.ensureCode({ id: U(101), ownerUserId: U(1), code: "ABCDEFGH", nowMs: 1_800_000_000_000 });
    await c.store.insertAttribution(referral(1, U(1), U(2), U(101)), []);
    const pg: PgliteLike = c.pg;
    const asUser = async (userId: string, stmt: string): Promise<{ rows: unknown[] }> => {
      await pg.exec(`set role app_user; select set_config('app.user_id', '${userId}', false); select set_config('app.role', 'user', false);`);
      try {
        return await pg.query<unknown>(stmt);
      } finally {
        await pg.exec(`reset role`);
      }
    };
    expect((await asUser(U(1), `select id from referrals`)).rows).toHaveLength(1);
    expect((await asUser(U(2), `select id from referrals`)).rows).toHaveLength(1);
    expect((await asUser(U(3), `select id from referrals`)).rows).toHaveLength(0);
    const upd = await asUser(U(2), `update referrals set status = 'rejected', reject_reason = 'x' returning id`);
    expect(upd.rows).toHaveLength(0);
  });
});
