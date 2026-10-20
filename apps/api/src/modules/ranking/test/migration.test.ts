import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTestDatabaseUpTo, lintMigration } from "@outlet/db";
import { describe, expect, it } from "vitest";

const read = (f: string) =>
  readFileSync(fileURLToPath(new URL(`../../../../../../packages/db/migrations/${f}`, import.meta.url)), "utf8");
const SQL79 = read("0079_ranking_v2_shadow.sql");
const SQL80 = read("0080_ranking_v2_eval_runs.sql");
const RUN = "00000000-0000-7000-8000-000000000001";
const P = "00000000-0000-4000-8000-000000007001";

const setup = async () => {
  const db = await createTestDatabaseUpTo(11);
  await db.exec(SQL79);
  await db.exec(SQL80);
  await db.query(
    `INSERT INTO ranking_shadow_runs (id, module, served_model_version, shadow_model_version, personalized, candidate_count, k, overlap_permille, top1_same, mean_rank_shift_milli, created_at)
     VALUES ($1, 'feed', 'v1', 'v2', false, 5, 10, 500, true, 0, now())`,
    [RUN],
  );
  return db;
};

describe("migrations 0079 and 0080", () => {
  it("pass the migration linter", () => {
    expect(lintMigration(SQL79)).toEqual([]);
    expect(lintMigration(SQL80)).toEqual([]);
  });

  it("refuse a budget-like key in shadow features", async () => {
    const db = await setup();
    const ins = (features: string) =>
      db.query(`INSERT INTO ranking_shadow_items (run_id, product_id, v1_rank, v2_rank, v2_score_milli, features) VALUES ($1, $2, 1, 1, 1, $3::jsonb)`, [RUN, P, features]);
    await expect(ins('{"remaining_budget": 100}')).rejects.toThrow();
    await expect(ins('{"afford_ceiling": 100}')).rejects.toThrow();
    await ins('{"popularity": 10}');
    await db.close();
  });

  it("is invisible to shoppers and sellers, readable by the system role", async () => {
    const db = await setup();
    const as = async (role: string): Promise<number> => {
      await db.exec("BEGIN");
      await db.exec("SET LOCAL ROLE app_user");
      await db.query("SELECT set_config('app.role', $1, true)", [role]);
      const r = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM ranking_shadow_runs");
      await db.exec("COMMIT");
      return Number(r.rows[0]?.n);
    };
    expect(await as("system")).toBe(1);
    expect(await as("seller")).toBe(0);
    expect(await as("shopper")).toBe(0);
    await db.close();
  });

  it("evaluation rows are append only for the app role", async () => {
    const db = await setup();
    await db.exec("BEGIN");
    await db.exec("SET LOCAL ROLE app_user");
    await db.query("SELECT set_config('app.role', 'system', true)");
    await expect(db.query("DELETE FROM ranking_eval_runs")).rejects.toThrow();
    await db.exec("ROLLBACK");
    await db.close();
  });
});
