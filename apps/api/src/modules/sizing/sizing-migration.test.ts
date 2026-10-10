import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintMigration, defaultMigrationsDir, createTestDatabaseUpTo } from "@outlet/db";

type PGlite = Awaited<ReturnType<typeof createTestDatabaseUpTo>>;

/**
 * Baseline 0001..0011 comes from the shared helper. Numbers 0012 and 0016 belong to other waves,
 * so the two files this module needs (0013 stores for the FK, 0017 itself) are applied by name.
 */
async function applyNamed(db: PGlite, name: string): Promise<string> {
  const sql = await readFile(join(defaultMigrationsDir(), `${name}.sql`), "utf8");
  await db.exec(sql);
  return sql;
}

const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const USER_A = U(1);
const USER_B = U(2);
const STORE_A = U(11);
const STORE_B = U(12);

let db: PGlite;
let sizingSql = "";

beforeAll(async () => {
  db = await createTestDatabaseUpTo(11);
  await applyNamed(db, "0013_stores");
  sizingSql = await applyNamed(db, "0017_sizing");
  await db.query(`INSERT INTO users (id) VALUES ($1), ($2)`, [USER_A, USER_B]);
  await db.query(
    `INSERT INTO stores (id, seller_id, kind, slug, name_ar, status, seller_kyc_state) VALUES
       ($1, $3, 'local', 'store-a', 'متجر أ', 'ACTIVE', 'APPROVED'),
       ($2, $4, 'local', 'store-b', 'متجر ب', 'ACTIVE', 'APPROVED')`,
    [STORE_A, STORE_B, U(21), U(22)],
  );
}, 60_000);

afterAll(async () => {
  await db.close();
});

/** Runs `fn` inside a transaction as app_user with the given session identity (rolled back). */
async function asApp<T>(
  who: { user?: string; role: string; stores?: string[] },
  fn: (q: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) => Promise<T>,
): Promise<T> {
  let out: T | undefined;
  try {
    await db.transaction(async (tx) => {
      await tx.exec("SET LOCAL ROLE app_user");
      await tx.query(
        `SELECT set_config('app.user_id', $1, true), set_config('app.role', $2, true), set_config('app.store_ids', $3, true)`,
        [who.user ?? "", who.role, (who.stores ?? []).join(",")],
      );
      out = await fn((sql, params) => tx.query(sql, params) as Promise<{ rows: Record<string, unknown>[] }>);
      throw new Error("__rollback__");
    });
  } catch (e) {
    if (!(e instanceof Error) || e.message !== "__rollback__") throw e;
  }
  return out as T;
}

const rejects = async (p: Promise<unknown>, re: RegExp): Promise<void> => {
  await expect(p).rejects.toThrow(re);
};

const enc = "decode('deadbeef','hex')";

describe("0017_sizing structure", () => {
  it("passes the migration linter (expand only)", () => {
    expect(lintMigration(sizingSql)).toEqual([]);
  });

  it("has no date of birth, photo or plaintext measurement columns on size_profiles", async () => {
    const r = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'size_profiles'`,
    );
    const cols = r.rows.map((x) => x.column_name);
    expect(cols).toEqual(expect.arrayContaining(["label", "measurements", "quick_start"]));
    for (const c of cols) {
      expect(c).not.toMatch(/dob|birth|photo|image|media|waist|bust|height|weight/);
    }
    const types = await db.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name = 'size_profiles' AND column_name IN ('label', 'measurements', 'quick_start')`,
    );
    expect(types.rows.length).toBe(3);
    expect(types.rows.every((t) => t.data_type === "bytea")).toBe(true);
  });

  it("seeds the chart templates", async () => {
    const r = await db.query<{ product_type: string }>(`SELECT product_type FROM size_chart_templates ORDER BY 1`);
    expect(r.rows.map((x) => x.product_type)).toEqual(["bottoms", "dresses", "kids_tops", "outerwear", "shoes", "tops"]);
  });

  it("caps live profiles at 6 per user and frees a slot on soft delete", async () => {
    const insert = (i: number) =>
      db.query(`INSERT INTO size_profiles (user_id, kind, label) VALUES ($1, 'ME', ${enc})`, [USER_B]).then(() => i);
    for (let i = 0; i < 6; i += 1) await insert(i);
    await rejects(insert(6), /already holds 6 size profiles/);
    await db.query(
      `UPDATE size_profiles SET deleted_at = now() WHERE id = (SELECT id FROM size_profiles WHERE user_id = $1 LIMIT 1)`,
      [USER_B],
    );
    await insert(7);
    await db.query(`DELETE FROM size_profiles WHERE user_id = $1`, [USER_B]);
  });

  it("closes enumerations and keeps charts immutable", async () => {
    await rejects(db.query(`INSERT INTO size_profiles (user_id, kind, label) VALUES ($1, 'PET', ${enc})`, [USER_A]), /check/);
    await rejects(
      db.query(`INSERT INTO size_profiles (user_id, kind, label, fit_pref) VALUES ($1, 'ME', ${enc}, 'TIGHT')`, [USER_A]),
      /check/,
    );
    const ins = await db.query<{ id: string }>(
      `INSERT INTO size_charts (store_id, product_type, chart_version, unit_entered, rows, validated)
       VALUES ($1, 'tops', 1, 'cm', '[{"sizeLabel":"S","measurements":{}}]', true) RETURNING id`,
      [STORE_A],
    );
    await rejects(db.query(`UPDATE size_charts SET validated = false WHERE id = $1`, [ins.rows[0]?.id]), /append-only|immutable|not allowed|forbid/i);
    await rejects(db.query(`DELETE FROM size_charts WHERE id = $1`, [ins.rows[0]?.id]), /append-only|immutable|not allowed|forbid/i);
    await rejects(
      db.query(
        `INSERT INTO size_charts (store_id, product_type, chart_version, unit_entered, rows, validated)
         VALUES ($1, 'tops', 1, 'cm', '[{"sizeLabel":"S","measurements":{}}]', false)`,
        [STORE_A],
      ),
      /duplicate key/,
    );
    await rejects(
      db.query(
        `INSERT INTO size_charts (store_id, product_type, chart_version, unit_entered, rows, validated, validation_errors)
         VALUES ($1, 'tops', 2, 'cm', '[{"sizeLabel":"S","measurements":{}}]', true, '[{"code":"x"}]')`,
        [STORE_A],
      ),
      /check/,
    );
    await rejects(
      db.query(
        `INSERT INTO size_charts (store_id, product_type, chart_version, unit_entered, rows, validated)
         VALUES ($1, 'tops', 3, 'cm', '[]', false)`,
        [STORE_A],
      ),
      /check/,
    );
  });

  it("allows one feedback per order line and closes the rating domain", async () => {
    const q = (rating: string, line: string) =>
      db.query(
        `INSERT INTO fit_feedback (order_line_id, user_id, product_id, brand_id, product_type, size_label, rating)
         VALUES ($1, $2, $3, $4, 'tops', 'M', $5)`,
        [line, USER_A, U(31), U(41), rating],
      );
    await q("TOO_SMALL", U(51));
    await rejects(q("OK", U(51)), /duplicate key/);
    await rejects(q("HUGE", U(52)), /check/);
  });

  it("refuses an item flag decided on fewer than 20 events and a demand cell below 50", async () => {
    const chart = await db.query<{ id: string }>(`SELECT id FROM size_charts WHERE store_id = $1 LIMIT 1`, [STORE_A]);
    const chartId = chart.rows[0]?.id;
    await rejects(
      db.query(
        `INSERT INTO item_fit_flags (product_id, size_chart_id, n_small, n_ok, n_large, flag) VALUES ($1, $2, 19, 0, 0, 'RUNS_SMALL')`,
        [U(31), chartId],
      ),
      /check/,
    );
    await db.query(
      `INSERT INTO item_fit_flags (product_id, size_chart_id, n_small, n_ok, n_large, flag) VALUES ($1, $2, 20, 0, 0, 'RUNS_SMALL')`,
      [U(31), chartId],
    );
    const demand = (n: number) =>
      db.query(
        `INSERT INTO seller_size_demand_agg (store_id, product_type, size_label, week_start, demand_count)
         VALUES ($1, 'tops', 'M', '2026-10-05', $2)`,
        [STORE_A, n],
      );
    await rejects(demand(49), /check/);
    await demand(50);
  });

  it("logs recommendations pseudonymously with confidence in [0,1]", async () => {
    const ins = (conf: number, pid: string) =>
      db.query(
        `INSERT INTO size_recommendation_log (pseudonymous_id, product_id, recommended_size, confidence, model_version)
         VALUES ($1, $2, 'M', $3, 'fit-v1')`,
        [pid, U(31), conf],
      );
    await ins(0.82, "ab".repeat(16));
    await rejects(ins(1.2, "ab".repeat(16)), /check|out of range|numeric/);
    await rejects(ins(0.5, USER_A), /check/);
  });
});

describe("0017_sizing row level security", () => {
  it("profiles are owner only, other owners see nothing and cannot insert for someone else", async () => {
    const own = await db.query<{ id: string }>(
      `INSERT INTO size_profiles (user_id, kind, label, measurements) VALUES ($1, 'ME', ${enc}, ${enc}) RETURNING id`,
      [USER_A],
    );
    const id = own.rows[0]?.id;
    try {
      const asA = await asApp({ user: USER_A, role: "customer" }, (q) => q(`SELECT id FROM size_profiles`));
      expect(asA.rows.map((r) => r.id)).toEqual([id]);
      const asB = await asApp({ user: USER_B, role: "customer" }, (q) => q(`SELECT id FROM size_profiles`));
      expect(asB.rows).toEqual([]);
      const seller = await asApp({ user: U(90), role: "seller", stores: [STORE_A] }, (q) => q(`SELECT id FROM size_profiles`));
      expect(seller.rows).toEqual([]);
      const none = await asApp({ role: "" }, (q) => q(`SELECT id FROM size_profiles`));
      expect(none.rows).toEqual([]);
      await rejects(
        asApp({ user: USER_B, role: "customer" }, (q) =>
          q(`INSERT INTO size_profiles (user_id, kind, label) VALUES ($1, 'ME', ${enc})`, [USER_A]),
        ),
        /row-level security/,
      );
      // B cannot update A's row (silently matches nothing)
      const upd = await asApp({ user: USER_B, role: "customer" }, (q) =>
        q(`UPDATE size_profiles SET modest_fit = true WHERE id = $1 RETURNING id`, [id]),
      );
      expect(upd.rows).toEqual([]);
      // soft deleted rows disappear from the owner too
      await db.query(`UPDATE size_profiles SET deleted_at = now() WHERE id = $1`, [id]);
      const gone = await asApp({ user: USER_A, role: "customer" }, (q) => q(`SELECT id FROM size_profiles`));
      expect(gone.rows).toEqual([]);
    } finally {
      await db.query(`DELETE FROM size_profiles WHERE id = $1`, [id]);
    }
  });

  it("charts: validated rows are public, drafts only for the owning store, writes only to own store", async () => {
    await db.query(
      `INSERT INTO size_charts (store_id, product_type, chart_version, unit_entered, rows, validated, validation_errors)
       VALUES ($1, 'dresses', 1, 'cm', '[{"sizeLabel":"S","measurements":{}}]', false, '[{"code":"missing_measure"}]')`,
      [STORE_B],
    );
    const shopper = await asApp({ user: USER_A, role: "customer" }, (q) => q(`SELECT store_id, validated FROM size_charts`));
    expect(shopper.rows.every((r) => r.validated === true)).toBe(true);
    const sellerA = await asApp({ user: U(90), role: "seller", stores: [STORE_A] }, (q) => q(`SELECT store_id, validated FROM size_charts`));
    expect(sellerA.rows.some((r) => r.store_id === STORE_B && r.validated === false)).toBe(false);
    const sellerB = await asApp({ user: U(91), role: "seller", stores: [STORE_B] }, (q) => q(`SELECT store_id, validated FROM size_charts`));
    expect(sellerB.rows.some((r) => r.store_id === STORE_B && r.validated === false)).toBe(true);
    await rejects(
      asApp({ user: U(90), role: "seller", stores: [STORE_A] }, (q) =>
        q(
          `INSERT INTO size_charts (store_id, product_type, chart_version, unit_entered, rows, validated)
           VALUES ($1, 'tops', 9, 'cm', '[{"sizeLabel":"S","measurements":{}}]', true)`,
          [STORE_B],
        ),
      ),
      /row-level security/,
    );
  });

  it("feedback is owner only: a seller of the same store reads nothing", async () => {
    const asA = await asApp({ user: USER_A, role: "customer" }, (q) => q(`SELECT order_line_id FROM fit_feedback`));
    expect(asA.rows.length).toBe(1);
    const asB = await asApp({ user: USER_B, role: "customer" }, (q) => q(`SELECT order_line_id FROM fit_feedback`));
    expect(asB.rows).toEqual([]);
    const seller = await asApp({ user: U(90), role: "seller", stores: [STORE_A, STORE_B] }, (q) => q(`SELECT 1 FROM fit_feedback`));
    expect(seller.rows).toEqual([]);
  });

  it("demand is store scoped for reads and never writable by the app roles", async () => {
    await db.query(
      `INSERT INTO seller_size_demand_agg (store_id, product_type, size_label, week_start, demand_count)
       VALUES ($1, 'tops', 'L', '2026-10-05', 75)`,
      [STORE_B],
    );
    const a = await asApp({ user: U(90), role: "seller", stores: [STORE_A] }, (q) => q(`SELECT store_id FROM seller_size_demand_agg`));
    expect(a.rows.every((r) => r.store_id === STORE_A)).toBe(true);
    expect(a.rows.length).toBe(1);
    await rejects(
      asApp({ user: U(90), role: "seller", stores: [STORE_A] }, (q) =>
        q(
          `INSERT INTO seller_size_demand_agg (store_id, product_type, size_label, week_start, demand_count)
           VALUES ($1, 'tops', 'XL', '2026-10-05', 80)`,
          [STORE_A],
        ),
      ),
      /row-level security/,
    );
    const shopper = await asApp({ user: USER_A, role: "customer" }, (q) => q(`SELECT 1 FROM seller_size_demand_agg`));
    expect(shopper.rows).toEqual([]);
  });

  it("the recommendation log is invisible to shoppers and sellers", async () => {
    const shopper = await asApp({ user: USER_A, role: "customer" }, (q) => q(`SELECT 1 FROM size_recommendation_log`));
    expect(shopper.rows).toEqual([]);
    const seller = await asApp({ user: U(90), role: "seller", stores: [STORE_A] }, (q) => q(`SELECT 1 FROM size_recommendation_log`));
    expect(seller.rows).toEqual([]);
    const system = await asApp({ role: "system" }, (q) => q(`SELECT 1 FROM size_recommendation_log`));
    expect(system.rows.length).toBe(1);
  });
});
