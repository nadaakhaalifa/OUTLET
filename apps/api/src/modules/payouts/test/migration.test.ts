import { readFileSync } from "node:fs";
import { lintMigration } from "@outlet/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { MIGRATION_0035, createPayoutsDatabase } from "./db";
import { STORE_A, STORE_B, U } from "./fixtures";

const SQL = readFileSync(MIGRATION_0035, "utf8");
let db: PGlite;

const as = async <T>(role: string, userId: string, stores: string, fn: () => Promise<T>): Promise<T> => {
  await db.exec("BEGIN");
  try {
    await db.exec("SET LOCAL ROLE app_user");
    await db.query("select set_config('app.role',$1,true), set_config('app.user_id',$2,true), set_config('app.store_ids',$3,true)", [
      role,
      userId,
      stores,
    ]);
    const out = await fn();
    await db.exec("COMMIT");
    return out;
  } catch (e) {
    await db.exec("ROLLBACK");
    throw e;
  }
};
const count = async (table: string): Promise<number> =>
  Number((await db.query<{ n: string }>(`select count(*)::text as n from ${table}`)).rows[0]?.n);

beforeAll(async () => {
  db = await createPayoutsDatabase();
  await db.exec(`
    insert into payouts (id, store_id, cycle_key, cutoff_at, amount, eligible_total, line_count)
    values ('${U(100)}','${STORE_A}','2026-10-11', now(), 100, 100, 1),
           ('${U(101)}','${STORE_B}','2026-10-11', now(), 200, 200, 1);
    insert into payout_lines (payout_id, store_id, source_type, source_id, amount)
    values ('${U(100)}','${STORE_A}','seller_order','o-a',100), ('${U(101)}','${STORE_B}','seller_order','o-b',200);
    insert into payout_attempts (payout_id, attempt_no, outcome, at) values ('${U(100)}',1,'accepted',now());
    insert into settlement_files (id, kind, provider, settlement_id, checksum, status, line_count, gross_total, fee_total, net_total, received_at)
    values ('${U(300)}','psp','fakepay','S1','${"a".repeat(64)}','parsed',1,100,0,100, now());
    insert into recon_runs (id, mode, nightly_key, started_at, finished_at, window_from, window_to, finding_count, opened, escalated, resolved, ok)
    values ('${U(400)}','nightly','2026-10-11', now(), now(), now(), now(), 0,0,0,0,true);
    insert into recon_tickets (id, dedupe_key, source, kind, severity, ref, amount_delta, item_at, status, first_seen_at, last_seen_at, last_run_id)
    values ('${U(500)}','k','psp_settlement','amount_mismatch','high','r',1, now(),'open', now(), now(), '${U(400)}');`);
}, 60_000);
afterAll(async () => {
  await db.close();
});

describe("0035_payouts_reconciliation", () => {
  it("passes the expand-only migration linter", () => {
    expect(lintMigration(SQL)).toEqual([]);
  });

  it("applies cleanly and creates no IBAN or holder-name column", async () => {
    const cols = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_name in ('payouts','payout_lines','payout_attempts','payout_status_history','settlement_files','settlement_file_lines','recon_runs','recon_tickets')`,
    );
    const names = cols.rows.map((r) => r.column_name);
    expect(names).toContain("iban_last4");
    expect(names.filter((n) => /^iban$|holder|card|pan|cvv/.test(n))).toEqual([]);
  });

  it("a store sees only its own payouts, lines and history", async () => {
    await as("seller", U(9), STORE_A, async () => {
      expect(await count("payouts")).toBe(1);
      expect(await count("payout_lines")).toBe(1);
      expect(await count("payout_attempts")).toBe(0); // attempts are staff only
    });
    await as("seller", U(9), STORE_B, async () => {
      const r = await db.query<{ id: string }>("select id::text as id from payouts");
      expect(r.rows.map((x) => x.id)).toEqual([U(101)]);
    });
  });

  it("shoppers and non-finance staff see nothing; finance, ops and system see all", async () => {
    for (const role of ["customer", "support", "marketing", "dpo"]) {
      await as(role, U(9), "", async () => {
        expect(await count("payouts")).toBe(0);
        expect(await count("settlement_files")).toBe(0);
        expect(await count("recon_tickets")).toBe(0);
      });
    }
    for (const role of ["finance", "ops", "system"]) {
      await as(role, U(9), "", async () => {
        expect(await count("payouts")).toBe(2);
        expect(await count("recon_tickets")).toBe(1);
        expect(await count("recon_runs")).toBe(1);
      });
    }
  });

  it("only the system role can write", async () => {
    for (const role of ["seller", "finance", "ops", "customer"]) {
      await expect(
        as(role, U(9), STORE_A, () =>
          db.query(
            `insert into payouts (id, store_id, cycle_key, cutoff_at, amount, eligible_total, line_count)
             values ('${U(150)}','${STORE_A}','2026-10-18', now(), 1, 1, 1)`,
          ),
        ),
      ).rejects.toThrow(/row-level security/);
    }
    await expect(
      as("finance", U(9), "", () => db.query(`insert into recon_tickets (id, dedupe_key, source, kind, severity, ref, amount_delta, item_at, status, first_seen_at, last_seen_at) values ('${U(501)}','z','run','x','high','r',0,now(),'open',now(),now())`)),
    ).rejects.toThrow(/row-level security/);
    // a seller's UPDATE affects no rows under RLS (no policy), so the amount cannot be touched either
    await as("seller", U(9), STORE_A, async () => {
      const r = await db.query(`update payouts set status = 'APPROVED' where id = '${U(100)}' returning id`);
      expect(r.rows).toHaveLength(0);
    });
  });

  it("enforces the money invariants as constraints", async () => {
    await expect(
      db.query(`insert into payouts (id, store_id, cycle_key, cutoff_at, amount, eligible_total, netted_total, line_count) values ('${U(160)}','${STORE_A}','2026-10-25', now(), 50, 100, 10, 1)`),
    ).rejects.toThrow(/payouts_net_chk/);
    await expect(
      db.query(`insert into payouts (id, store_id, cycle_key, cutoff_at, status, amount, eligible_total, line_count) values ('${U(161)}','${STORE_A}','2026-10-26', now(), 'ON_HOLD', 1, 1, 1)`),
    ).rejects.toThrow(/payouts_hold_chk/);
    await expect(
      db.query(`insert into settlement_files (id, kind, provider, settlement_id, checksum, status, gross_total, fee_total, net_total, received_at) values ('${U(301)}','psp','fakepay','S9','${"b".repeat(64)}','parsed',100,10,99, now())`),
    ).rejects.toThrow(/settlement_files_totals_chk/);
    await expect(
      db.query(`insert into settlement_files (id, kind, provider, settlement_id, checksum, status, gross_total, fee_total, net_total, received_at) values ('${U(302)}','psp','fakepay','S1','${"c".repeat(64)}','parsed',1,0,1, now())`),
    ).rejects.toThrow(/settlement_files_settlement_uq/);
    await expect(
      db.query(`insert into settlement_files (id, kind, provider, checksum, status, received_at) values ('${U(303)}','psp','fakepay','${"a".repeat(64)}','rejected', now())`),
    ).rejects.toThrow(/settlement_files_checksum_uq/);
    await expect(
      db.query(`insert into recon_runs (id, mode, nightly_key, started_at, finished_at, window_from, window_to, finding_count, opened, escalated, resolved, ok) values ('${U(401)}','nightly','2026-10-11', now(), now(), now(), now(), 0,0,0,0,true)`),
    ).rejects.toThrow(/recon_runs_nightly_uq/);
  });

  it("settlement files, lines, runs, attempts are immutable", async () => {
    await expect(db.query(`update settlement_files set provider = 'x'`)).rejects.toThrow(/append-only/);
    await expect(db.query(`delete from recon_runs`)).rejects.toThrow(/append-only/);
    await expect(db.query(`delete from payout_attempts`)).rejects.toThrow(/append-only/);
  });
});
