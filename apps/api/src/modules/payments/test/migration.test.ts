import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTestDatabaseUpTo, lintMigration } from "@outlet/db";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SQL = readFileSync(fileURLToPath(new URL("../../../../../../packages/db/migrations/0032_payments.sql", import.meta.url)), "utf8");
const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let db: PGlite;

const as = async <T>(role: string, userId: string, fn: () => Promise<T>): Promise<T> => {
  await db.exec("BEGIN");
  try {
    await db.exec("SET LOCAL ROLE app_user");
    await db.query("select set_config('app.role',$1,true), set_config('app.user_id',$2,true), set_config('app.store_ids','',true)", [role, userId]);
    const out = await fn();
    await db.exec("COMMIT");
    return out;
  } catch (e) {
    await db.exec("ROLLBACK");
    throw e;
  }
};
const count = async (t: string): Promise<number> => Number((await db.query<{ n: string }>(`select count(*)::text as n from ${t}`)).rows[0]?.n);
const sha = "a".repeat(64);

beforeAll(async () => {
  db = await createTestDatabaseUpTo(32);
  await db.exec(`insert into users (id, status) values ('${U(1)}','active'), ('${U(2)}','active')`);
  await db.exec(`
    insert into payment_intents (id, order_group_id, user_id, provider, provider_ref, method, amount, status, idempotency_key, expires_at)
    values ('${U(100)}','${U(200)}','${U(1)}','fake_psp','pi_1','card',100000,'SUCCEEDED','${U(200)}', now() + interval '10 min'),
           ('${U(101)}','${U(201)}','${U(2)}','fake_psp','pi_2','card',50000,'REQUIRES_ACTION','${U(201)}', now() + interval '10 min');
    insert into payment_refunds (id, intent_id, idempotency_key, amount, reason) values ('${U(300)}','${U(100)}','k1',1000,'return');
    insert into payment_methods (id, user_id, provider, psp_token, brand, last4, exp_month, exp_year, fingerprint)
    values ('${U(400)}','${U(1)}','fake_psp','tok_aaaaaaaa','visa','4242',12,2030,'fp_aaaaaaaa');
    insert into payment_events_raw (id, provider, event_id, signature_ok, body, body_sha256)
    values ('${U(500)}','fake_psp','evt_1',true,'{}'::jsonb,'${sha}');`);
}, 60_000);
afterAll(async () => {
  await db.close();
});

describe("0032_payments", () => {
  it("passes the expand-only migration linter", () => {
    expect(lintMigration(SQL)).toEqual([]);
  });

  it("RLS: owners read their own, strangers nothing, system everything", async () => {
    expect(await as("customer", U(1), () => count("payment_intents"))).toBe(1);
    expect(await as("customer", U(2), () => count("payment_intents"))).toBe(1);
    expect(await as("customer", U(99), () => count("payment_intents"))).toBe(0);
    expect(await as("system", "", () => count("payment_intents"))).toBe(2);
    expect(await as("customer", U(1), () => count("payment_refunds"))).toBe(1);
    expect(await as("customer", U(2), () => count("payment_refunds"))).toBe(0);
    expect(await as("customer", U(1), () => count("payment_methods"))).toBe(1);
    expect(await as("customer", U(2), () => count("payment_methods"))).toBe(0);
  });

  it("raw webhook events are invisible to every non-system role", async () => {
    expect(await as("customer", U(1), () => count("payment_events_raw"))).toBe(0);
    expect(await as("seller", U(1), () => count("payment_events_raw"))).toBe(0);
    expect(await as("support", U(1), () => count("payment_events_raw"))).toBe(0);
    expect(await as("system", "", () => count("payment_events_raw"))).toBe(1);
  });

  it("customers cannot write intents, refunds, cards or events, nor edit their own intent", async () => {
    await expect(
      as("customer", U(1), () =>
        db.query(
          `insert into payment_intents (id, order_group_id, user_id, provider, method, amount, idempotency_key, expires_at)
           values ('${U(110)}','${U(210)}','${U(1)}','fake_psp','card',1,'k', now())`,
        ),
      ),
    ).rejects.toThrow();
    const upd = await as("customer", U(1), () => db.query(`update payment_intents set status = 'FAILED' where id = '${U(100)}' returning id`));
    expect(upd.rows).toHaveLength(0);
    await expect(
      as("customer", U(1), () =>
        db.query(
          `insert into payment_methods (id, user_id, provider, psp_token, brand, last4, exp_month, exp_year, fingerprint)
           values ('${U(401)}','${U(1)}','fake_psp','tok_bbbbbbbb','visa','1111',1,2030,'fp_bbbbbbbb')`,
        ),
      ),
    ).rejects.toThrow();
  });

  it("the state machine is enforced in the database: terminal states are final and edges are declared", async () => {
    await db.exec(`insert into payment_intents (id, order_group_id, user_id, provider, method, amount, status, idempotency_key, expires_at)
                   values ('${U(120)}','${U(220)}','${U(1)}','fake_psp','card',1000,'FAILED','k', now())`);
    await expect(db.query(`update payment_intents set status = 'SUCCEEDED' where id = '${U(120)}'`)).rejects.toThrow(/terminal/);
    await expect(db.query(`update payment_intents set status = 'REFUNDED', refunded_amount = 100000 where id = '${U(101)}'`)).rejects.toThrow(/illegal/);
    await expect(db.query(`update payment_intents set status = 'CREATED' where id = '${U(100)}'`)).rejects.toThrow(/illegal/);
  });

  it("identity and amount are immutable; provider ref is write-once; refunds never decrease", async () => {
    await expect(db.query(`update payment_intents set amount = 1 where id = '${U(100)}'`)).rejects.toThrow(/immutable/);
    await expect(db.query(`update payment_intents set order_group_id = '${U(299)}' where id = '${U(100)}'`)).rejects.toThrow(/immutable/);
    await expect(db.query(`update payment_intents set provider_ref = 'other' where id = '${U(100)}'`)).rejects.toThrow(/immutable/);
    await db.exec(`update payment_intents set status = 'PARTIALLY_REFUNDED', refunded_amount = 30000 where id = '${U(100)}'`);
    await expect(db.query(`update payment_intents set refunded_amount = 10000 where id = '${U(100)}'`)).rejects.toThrow();
  });

  it("check constraints: positive EGP money, refund bounds consistent with status, known methods", async () => {
    const bad = (s: string) => expect(db.query(s)).rejects.toThrow();
    await bad(`insert into payment_intents (id, order_group_id, user_id, provider, method, amount, idempotency_key, expires_at)
               values ('${U(130)}','${U(230)}','${U(1)}','fake_psp','card',0,'k', now())`);
    await bad(`insert into payment_intents (id, order_group_id, user_id, provider, method, amount, currency, idempotency_key, expires_at)
               values ('${U(131)}','${U(231)}','${U(1)}','fake_psp','card',1,'USD','k', now())`);
    await bad(`insert into payment_intents (id, order_group_id, user_id, provider, method, amount, idempotency_key, expires_at)
               values ('${U(132)}','${U(232)}','${U(1)}','fake_psp','bitcoin',1,'k', now())`);
    await bad(`update payment_intents set refunded_amount = 5 where id = '${U(101)}'`);
    await bad(`insert into payment_intents (id, order_group_id, user_id, provider, method, amount, idempotency_key, expires_at)
               values ('${U(133)}','${U(200)}','${U(1)}','fake_psp','card',1,'k', now())`);
  });

  it("webhook dedup: unique per (provider, event id); unverified rows must use the content-derived id", async () => {
    await expect(
      db.query(`insert into payment_events_raw (id, provider, event_id, signature_ok, body, body_sha256)
                values ('${U(501)}','fake_psp','evt_1',true,'{}'::jsonb,'${sha}')`),
    ).rejects.toThrow();
    await expect(
      db.query(`insert into payment_events_raw (id, provider, event_id, signature_ok, reject_reason, body, body_sha256)
                values ('${U(502)}','fake_psp','evt_forged',false,'bad_signature','{}'::jsonb,'${sha}')`),
    ).rejects.toThrow();
    await expect(
      db.query(`insert into payment_events_raw (id, provider, event_id, signature_ok, body, body_sha256)
                values ('${U(503)}','fake_psp','unverified:${sha}',true,'{}'::jsonb,'${sha}')`),
    ).rejects.toThrow();
    await db.exec(`insert into payment_events_raw (id, provider, event_id, signature_ok, reject_reason, body, body_sha256)
                   values ('${U(504)}','fake_psp','unverified:${sha}',false,'bad_signature','{}'::jsonb,'${sha}')`);
  });

  it("raw events: content immutable, processing mark write-once, never deleted", async () => {
    await expect(db.query(`update payment_events_raw set body = '{"x":1}'::jsonb where id = '${U(500)}'`)).rejects.toThrow(/immutable/);
    await db.exec(`update payment_events_raw set processed_at = now(), process_outcome = 'noop' where id = '${U(500)}'`);
    await expect(db.query(`update payment_events_raw set processed_at = now() + interval '1 hour' where id = '${U(500)}'`)).rejects.toThrow(/already processed/);
    await expect(db.query(`delete from payment_events_raw where id = '${U(500)}'`)).rejects.toThrow(/never deleted/);
  });

  it("refunds: idempotent per (intent, key), unique PSP reference, settled state is final", async () => {
    await expect(
      db.query(`insert into payment_refunds (id, intent_id, idempotency_key, amount, reason) values ('${U(301)}','${U(100)}','k1',5,'x')`),
    ).rejects.toThrow();
    await db.exec(`update payment_refunds set status = 'succeeded', provider_refund_ref = 'rf_1' where id = '${U(300)}'`);
    await expect(db.query(`update payment_refunds set status = 'failed' where id = '${U(300)}'`)).rejects.toThrow(/settled/);
    await expect(db.query(`update payment_refunds set amount = 5 where id = '${U(300)}'`)).rejects.toThrow(/immutable/);
    await db.exec(`insert into payment_refunds (id, intent_id, idempotency_key, amount, reason) values ('${U(302)}','${U(100)}','k2',5,'x')`);
    await expect(db.query(`update payment_refunds set provider_refund_ref = 'rf_1' where id = '${U(302)}'`)).rejects.toThrow();
  });

  it("saved cards: one row per PSP token, last4 is exactly four digits", async () => {
    await expect(
      db.query(`insert into payment_methods (id, user_id, provider, psp_token, brand, last4, exp_month, exp_year, fingerprint)
                values ('${U(402)}','${U(2)}','fake_psp','tok_aaaaaaaa','visa','4242',12,2030,'fp_aaaaaaaa')`),
    ).rejects.toThrow();
    await expect(
      db.query(`insert into payment_methods (id, user_id, provider, psp_token, brand, last4, exp_month, exp_year, fingerprint)
                values ('${U(403)}','${U(2)}','fake_psp','tok_cccccccc','visa','42x2',12,2030,'fp_cccccccc')`),
    ).rejects.toThrow();
  });
});
