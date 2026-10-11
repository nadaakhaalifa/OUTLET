import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintMigration } from "@outlet/db";
import { createPlusDatabase, migrationSql, type PgliteLike } from "./test/pglite-db";
import type { PlusDb } from "./adapters/kysely-store";

const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let pg: PgliteLike;
let db: PlusDb;

beforeAll(async () => {
  ({ pg, db } = await createPlusDatabase());
  await pg.query(`insert into users (id, status) values ($1,'active'), ($2,'active')`, [U(1), U(2)]);
  await pg.query(
    `insert into plans (id, code, billing_interval, price, version, effective_from) values ($1,'plus_monthly','month',20000,1,now())`,
    [U(100)],
  );
}, 60_000);
afterAll(async () => {
  await db.destroy();
});

const subscription = (id: number, user: number, status = "ACTIVE", extra = ""): Promise<unknown> =>
  pg.query(
    `insert into subscriptions (id, user_id, plan_id, plan_code, plan_version, billing_interval, status, period_start, period_end, psp_token_ref ${extra ? "," + extra.split("=")[0] : ""})
     values ($1,$2,$3,'plus_monthly',1,'month',$4, now(), now() + interval '30 days', 'tok' ${extra ? "," + extra.split("=")[1] : ""})`,
    [U(id), U(user), U(100), status],
  );

describe("0036_subscriptions", () => {
  it("passes the migration linter and is expand only", () => {
    expect(lintMigration(migrationSql("0036_subscriptions.sql"))).toEqual([]);
    const sql = readFileSync(new URL("../../../../../packages/db/migrations/0036_subscriptions.sql", import.meta.url), "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/\bALTER TABLE (?!\w+ ENABLE ROW LEVEL SECURITY)/i);
  });

  it("stores money as BIGINT piastres and no float columns", async () => {
    const r = await pg.query<{ table_name: string; column_name: string; data_type: string }>(
      `select table_name, column_name, data_type from information_schema.columns
       where table_name in ('plans','subscriptions','subscription_invoices','plus_savings_ledger','plus_signups')`,
    );
    expect(r.rows.filter((c) => /real|double|numeric/.test(c.data_type))).toEqual([]);
    const money = r.rows.filter((c) => ["price", "amount", "vat", "credit_applied", "net_recognition", "amount_saved"].includes(c.column_name));
    expect(money.length).toBeGreaterThanOrEqual(6);
    expect(money.every((c) => c.data_type === "bigint")).toBe(true);
  });

  it("allows one live subscription per user and frees the slot on EXPIRED", async () => {
    await subscription(1, 1);
    await expect(subscription(2, 1)).rejects.toThrow(/subscriptions_one_live_uq|unique/);
    await pg.query(`update subscriptions set status = 'EXPIRED' where id = $1`, [U(1)]);
    await subscription(2, 1);
    await expect(subscription(3, 2, "NOT_A_STATE")).rejects.toThrow(/check/);
  });

  it("is idempotent per (subscription, cycle, attempt) and caps recognised periods", async () => {
    const inv = (id: number, extra = "") =>
      pg.query(
        `insert into subscription_invoices (id, subscription_id, user_id, cycle, attempt, kind, amount, vat, period_start, status, psp_provider, issued_at ${extra ? "," + extra.split("=")[0] : ""})
         values ($1,$2,$3,1,0,'first',20000,2456,now(),'PAID','fake_psp',now() ${extra ? "," + extra.split("=")[1] : ""})`,
        [U(id), U(2), U(1)],
      );
    await inv(10);
    await expect(inv(11)).rejects.toThrow(/subscription_invoices_attempt_uq|unique/);
    await expect(
      pg.query(
        `insert into subscription_invoices (id, subscription_id, user_id, cycle, attempt, kind, amount, vat, period_start, status, psp_provider, issued_at, periods_total, periods_recognised)
         values ($1,$2,$3,2,0,'renewal',20000,2456,now(),'PAID','fake_psp',now(),1,2)`,
        [U(12), U(2), U(1)],
      ),
    ).rejects.toThrow(/check/);
  });

  it("B-5: a positive PAID invoice must name its PSP", async () => {
    await expect(
      pg.query(
        `insert into subscription_invoices (id, subscription_id, user_id, cycle, attempt, kind, amount, vat, period_start, status, issued_at)
         values ($1,$2,$3,3,0,'renewal',20000,2456,now(),'PAID',now())`,
        [U(13), U(2), U(1)],
      ),
    ).rejects.toThrow(/subscription_invoices_provider_chk|check/);
  });

  it("holds only hashed trial keys and refuses a double claim", async () => {
    const h = "a".repeat(64);
    await pg.query(`insert into trial_claims (person_key_hash, subscription_id, claimed_at) values ($1,$2,now())`, [h, U(2)]);
    await expect(
      pg.query(`insert into trial_claims (person_key_hash, subscription_id, claimed_at) values ($1,$2,now())`, [h, U(2)]),
    ).rejects.toThrow(/unique|duplicate/);
    await expect(
      pg.query(`insert into trial_claims (person_key_hash, subscription_id, claimed_at) values ('+201001234567',$1,now())`, [U(2)]),
    ).rejects.toThrow(/check/);
  });

  it("rejects an app_features row with an unknown group and an empty window", async () => {
    await expect(
      pg.query(
        `insert into entitlements (source_subscription_id, user_id, entitlement_group, entitlement_key, valid_from, valid_to) values ($1,$2,'misc','x',now(), now() + interval '1 day')`,
        [U(2), U(1)],
      ),
    ).rejects.toThrow(/check/);
    await expect(
      pg.query(
        `insert into entitlements (source_subscription_id, user_id, entitlement_group, entitlement_key, valid_from, valid_to) values ($1,$2,'app_features','x',now(), now())`,
        [U(2), U(1)],
      ),
    ).rejects.toThrow(/check/);
  });
});
