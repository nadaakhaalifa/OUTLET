import { afterAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import { KyselyAutoBuyStore, type AutoBuyDb } from "./kysely-store";
import { createAutoBuyDatabase, type PgliteLike } from "../test/pglite-db";
import { ID, SHA, U, attemptRec, describeAutoBuyStoreContract, mandateRec } from "../test/repository-contract";

const open: AutoBuyDb[] = [];
let seq = 0;
const ids = { uuidV7: (): string => `00000000-0000-7000-8000-${String(900_000 + ++seq).padStart(12, "0")}` };

/** One migrated database per file (migrations take seconds); every call resets all auto-buy state. */
let shared: Promise<{ pg: PgliteLike; db: AutoBuyDb }> | null = null;
const fresh = async () => {
  shared ??= createAutoBuyDatabase();
  const { pg, db } = await shared;
  if (!open.includes(db)) open.push(db);
  // Mandates and attempts RESTRICT the user delete (0057): clear them first, bypassing triggers.
  await pg.exec(`set session_replication_role = replica; delete from auto_buy_attempts; delete from auto_buy_mandates; reset session_replication_role;`);
  await pg.exec(`delete from users;`);
  // the outbox is append-only: report only rows newer than this call
  const baseline = Number((await pg.query<{ n: string }>(`select count(*)::text as n from outbox_events`)).rows[0]?.n ?? 0);
  return {
    pg,
    db,
    baseline,
    store: new KyselyAutoBuyStore(db, ids),
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

describeAutoBuyStoreContract("kysely/pglite", fresh);

describe("KyselyAutoBuyStore specifics", () => {
  const seed = async () => {
    const c = await fresh();
    await c.ensureUser(U(1));
    await c.ensureUser(U(2));
    await c.store.run(async (tx) => {
      await tx.putText({ version: 1, locale: "en", body: "I authorise the purchase of {{item}}.", bodySha256: SHA });
      await tx.insertMandate(mandateRec(1));
      await tx.insertMandate(mandateRec(2, { userId: U(2) }));
      await tx.insertAttempt(attemptRec(1, ID(1)));
    });
    return c;
  };

  it("row level security: owners see only their rows, a role without a user id sees none, nobody but system writes", async () => {
    const c = await seed();
    const asUser = async (userId: string | null, stmt: string): Promise<{ rows: unknown[] }> => {
      await c.pg.exec(
        `set role app_user; select set_config('app.user_id', '${userId ?? ""}', false); select set_config('app.role', 'user', false);`,
      );
      try {
        return await c.pg.query(stmt);
      } finally {
        await c.pg.exec(`reset role`);
      }
    };
    for (const table of ["auto_buy_mandates", "auto_buy_attempts"]) {
      expect((await asUser(U(1), `select user_id from ${table}`)).rows).toHaveLength(1);
      expect((await asUser(null, `select user_id from ${table}`)).rows).toHaveLength(0);
    }
    expect((await asUser(U(2), `update auto_buy_mandates set closed_reason = 'x' where user_id = '${U(1)}' returning id`)).rows).toHaveLength(0);
    // The owner cannot write either: the UPDATE policy is system only, so the row is invisible to it.
    expect((await asUser(U(1), `update auto_buy_mandates set status = 'DISARMED', closed_reason = 'x' where user_id = '${U(1)}' returning id`)).rows).toHaveLength(0);
    expect((await c.pg.query<{ status: string }>(`select status from auto_buy_mandates where id = '${ID(1)}'`)).rows[0]?.status).toBe("ARMED");
    await expect(
      asUser(U(1), `insert into auto_buy_attempts (id, mandate_id, user_id, price_event_id, mode, state, trigger_price) values (gen_random_uuid(), '${ID(1)}', '${U(1)}', 'x', 'notify_confirm', 'TRIGGERED', 1)`),
    ).rejects.toThrow();
  });

  it("an accepted mandate is immutable: terms cannot be edited, a closed rule cannot be reopened", async () => {
    const c = await seed();
    for (const set of ["target_price = 1", "max_price = 99999999", "psp_token_ref = 'tok_other_12345'", "size_label = 'XL'", "sku_id = gen_random_uuid()", "expires_at = expires_at + interval '1 day'"]) {
      await expect(c.pg.exec(`update auto_buy_mandates set ${set} where id = '${ID(1)}'`), set).rejects.toThrow();
    }
    await c.store.run((tx) => tx.closeMandate(ID(1), "DISARMED", "user_cancelled", 1_800_000_001_000));
    await expect(c.pg.exec(`update auto_buy_mandates set status = 'ARMED', closed_reason = null where id = '${ID(1)}'`)).rejects.toThrow();
  });

  it("mandate wording is immutable", async () => {
    const c = await seed();
    await expect(c.pg.exec(`update auto_buy_mandate_texts set body = 'changed text of more than twenty characters'`)).rejects.toThrow(/immutable/);
    await expect(c.pg.exec(`delete from auto_buy_mandate_texts`)).rejects.toThrow(/immutable/);
  });

  it("database checks: max below target, token without unattended mode, unattended without token, past expiry", async () => {
    const c = await seed();
    const base = (over: string) => `insert into auto_buy_mandates (id, user_id, sku_id, size_label, target_price, max_price, mode, psp_token_ref,
      expires_at, mandate_version, mandate_locale, terms_sha256, accepted_at, accepted_device_id) values (gen_random_uuid(), '${U(2)}', gen_random_uuid(), 'M', ${over})`;
    const ok = `100, 200, 'notify_confirm', null, now() + interval '1 day', 1, 'en', '${SHA}', now(), 'd'`;
    await expect(c.pg.exec(base(ok.replace("100, 200", "300, 200")))).rejects.toThrow(/check/);
    await expect(c.pg.exec(base(ok.replace("null,", "'tok_card_12345678',")))).rejects.toThrow(/check/);
    await expect(c.pg.exec(base(ok.replace("'notify_confirm'", "'unattended'")))).rejects.toThrow(/check/);
    await expect(c.pg.exec(base(ok.replace("now() + interval '1 day'", "now() - interval '1 day'")))).rejects.toThrow(/check/);
    await expect(c.pg.exec(base(ok))).resolves.toBeDefined();
  });

  it("outbox payloads carry ids and enums only: no price and no token reference", async () => {
    const c = await fresh();
    await c.ensureUser(U(1));
    await c.store.run(async (tx) => {
      await tx.emit([
        { type: "auto_buy.armed", userId: U(1), mandateId: ID(1), mode: "unattended" },
        { type: "auto_buy.notified", userId: U(1), mandateId: ID(1), attemptId: ID(501), mode: "unattended", cancelDeadlineMs: 1_800_000_900_000 },
        { type: "auto_buy.charged", userId: U(1), mandateId: ID(1), attemptId: ID(501), orderGroupId: ID(4242) },
        { type: "auto_buy.failed", userId: U(1), mandateId: ID(1), attemptId: ID(501), reason: "price_above_max" },
        { type: "auto_buy.cancelled", userId: U(1), mandateId: ID(1), attemptId: null, by: "user" },
      ]);
    });
    const rows = await c.pg.query<{ payload: Record<string, unknown> }>(`select payload from outbox_events order by id offset ${c.baseline}`);
    expect(rows.rows).toHaveLength(5);
    for (const r of rows.rows) expect(Object.keys(r.payload).every((k) => !/price|amount|token|psp/.test(k))).toBe(true);
  });

  it("B-3: account deletion no longer cascades the consent evidence: the user delete is refused", async () => {
    const c = await seed();
    await expect(c.pg.query(`delete from users where id = $1`, [U(1)])).rejects.toThrow(/foreign key|violates/i);
    expect((await c.pg.query(`select 1 from auto_buy_mandates where user_id = $1`, [U(1)])).rows).toHaveLength(1);
    expect((await c.pg.query(`select 1 from auto_buy_attempts where user_id = $1`, [U(1)])).rows).toHaveLength(1);
    await expect(c.pg.query(`delete from auto_buy_mandates where id = $1`, [ID(1)])).rejects.toThrow(/foreign key|violates/i);
  });

  it("B-3: the erasure scrub of device and vault reference is allowed, the accepted terms stay immutable", async () => {
    const c = await seed();
    // notify_confirm rules carry no token: scrubbing the device id alone must work.
    await c.pg.exec(`update auto_buy_mandates set accepted_device_id = 'pseudonym-xyz' where id = '${ID(1)}'`);
    expect((await c.pg.query<{ d: string }>(`select accepted_device_id as d from auto_buy_mandates where id = '${ID(1)}'`)).rows[0]?.d).toBe("pseudonym-xyz");
    await expect(c.pg.exec(`update auto_buy_mandates set accepted_at = now() where id = '${ID(1)}'`)).rejects.toThrow();
    await expect(c.pg.exec(`update auto_buy_mandates set terms_sha256 = '${"b".repeat(64)}' where id = '${ID(1)}'`)).rejects.toThrow();
  });

  it("B-3: a closed unattended rule may have its vault reference scrubbed to NULL; an armed one may not", async () => {
    const c = await fresh();
    await c.ensureUser(U(1));
    await c.store.run(async (tx) => {
      await tx.putText({ version: 1, locale: "en", body: "I authorise the purchase of {{item}}.", bodySha256: SHA });
      await tx.insertMandate(mandateRec(1, { mode: "unattended", pspTokenRef: "tok_card_12345678" }));
    });
    await expect(c.pg.exec(`update auto_buy_mandates set psp_token_ref = null where id = '${ID(1)}'`)).rejects.toThrow(/check/);
    await c.store.run((tx) => tx.closeMandate(ID(1), "DISARMED", "account_deleted", 1_800_000_001_000));
    await c.pg.exec(`update auto_buy_mandates set psp_token_ref = null where id = '${ID(1)}'`);
  });

  it("B-1: MANUAL_REVIEW is an accepted attempt state at the database", async () => {
    const c = await seed();
    await c.pg.exec(`update auto_buy_attempts set state = 'MANUAL_REVIEW', notice_sent_at = now(), cancel_deadline = now() + interval '20 minutes', failure_reason = 'x' where mandate_id = '${ID(1)}'`);
  });
});
