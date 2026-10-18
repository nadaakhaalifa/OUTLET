import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintMigration } from "@outlet/db";
import type { BrandVerificationDb } from "./adapters/kysely-store";
import { createBrandVerificationDatabase, migrationSql, type PgliteLike } from "./test/pglite-db";

const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let pg: PgliteLike;
let db: BrandVerificationDb;
beforeAll(async () => {
  ({ pg, db } = await createBrandVerificationDatabase());
}, 60_000);
afterAll(async () => {
  await db.destroy();
});

describe("0052_brand_verification", () => {
  it("passes the migration linter and is additive", () => {
    const sql = migrationSql("0052_brand_verification.sql");
    expect(lintMigration(sql)).toEqual([]);
    const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code).not.toMatch(/\bDROP\b/i);
    expect(code).not.toMatch(/\bREFERENCES\b/i);
  });
  it("has RLS enabled on every table", async () => {
    const names = ["bv_domain_verifications", "bv_claims", "bv_claim_conflicts", "bv_trademark_lookups", "bv_screenings", "bv_auto_check_reports", "bv_history"];
    const r = await pg.query<{ relrowsecurity: boolean }>(`select relrowsecurity from pg_class where relname = any($1)`, [names]);
    expect(r.rows).toHaveLength(names.length);
    expect(r.rows.every((x) => x.relrowsecurity)).toBe(true);
  });
  it("keeps evidence and history append-only and enforces checks", async () => {
    await pg.query(`insert into bv_history (id, application_id, action) values ($1,$2,'test.action')`, [U(1), U(2)]);
    await expect(pg.query(`update bv_history set action = 'other.action' where id = $1`, [U(1)])).rejects.toThrow();
    await expect(pg.query(`delete from bv_history where id = $1`, [U(1)])).rejects.toThrow();
    await expect(
      pg.query(`insert into bv_domain_verifications (application_id, applicant_id, domain, method, status, nonce, expires_at) values ($1,$2,'a.com','dns_txt','verified',$3,now())`, [U(3), U(4), "n".repeat(20)]),
    ).rejects.toThrow(/check/);
    await expect(
      pg.query(`insert into bv_claim_conflicts (id, conflict_key, application_ids, reasons, status) values ($1,$2,array[$3::uuid],'{}','open')`, [U(5), "k".repeat(40), U(6)]),
    ).rejects.toThrow(/check/);
  });
});
