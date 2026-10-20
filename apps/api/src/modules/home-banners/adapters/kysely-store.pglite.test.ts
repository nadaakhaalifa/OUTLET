import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTestDatabaseUpTo } from "@outlet/db";
import { afterAll, describe, expect, it } from "vitest";
import { createPgliteDatabase, type PgliteInstance } from "../../../platform/db";
import { describeHomeBannerStoreContract } from "../test/store-contract";
import { NOW, H, banner } from "../test/fixtures";
import { KyselyHomeBannerStore, type HomeBannerDb } from "./kysely-store";

const read = (f: string) => readFileSync(fileURLToPath(new URL(`../../../../../../packages/db/migrations/${f}`, import.meta.url)), "utf8");
const open: HomeBannerDb[] = [];

/** 0084 depends only on 0001-0011 (helpers, RLS roles). */
const fresh = async () => {
  const raw = await createTestDatabaseUpTo(11);
  await raw.exec(read("0084_home_banners.sql"));
  const db: HomeBannerDb = createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance);
  open.push(db);
  return { store: new KyselyHomeBannerStore(db), raw };
};

afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

describeHomeBannerStoreContract("kysely/pglite", fresh);

describe("0084 constraints and row level security", () => {
  const ins = (raw: PgliteInstance2, cols: string, vals: string) =>
    raw.exec(
      `INSERT INTO home_banners (id, title_ar, starts_at, ends_at, created_by, updated_by, ${cols}) VALUES (gen_random_uuid(), 'x', '2026-10-12T10:00:00Z', '2026-10-13T10:00:00Z', gen_random_uuid(), gen_random_uuid(), ${vals})`,
    );
  type PgliteInstance2 = { exec(sql: string): Promise<unknown> };

  it("enforces window, CTA shape, sponsorship, image key and text caps in the database", async () => {
    const { raw } = await fresh();
    await expect(ins(raw, "cta_kind, cta_target_id", "'store', 'store_1'")).resolves.toBeDefined();
    await expect(raw.exec(`INSERT INTO home_banners (id, title_ar, starts_at, ends_at, created_by, updated_by, cta_kind, cta_target_id) VALUES (gen_random_uuid(), 'x', '2026-10-13T10:00:00Z', '2026-10-12T10:00:00Z', gen_random_uuid(), gen_random_uuid(), 'store', 's')`)).rejects.toThrow();
    await expect(ins(raw, "cta_kind, cta_target_id", "'store', 'https://evil.example'")).rejects.toThrow();
    await expect(ins(raw, "cta_kind, cta_target_id", "'store', NULL")).rejects.toThrow();
    await expect(ins(raw, "cta_kind, cta_target_id, cta_query", "'search', NULL, 'http://evil.example'")).rejects.toThrow();
    await expect(ins(raw, "cta_kind, cta_query, cta_price_min, cta_price_max", "'search', 'linen', 500, 100")).rejects.toThrow();
    await expect(ins(raw, "cta_kind, cta_target_id, cta_price_min", "'drop', 'd1', 100")).rejects.toThrow();
    await expect(ins(raw, "cta_kind, cta_target_id, sponsored", "'store', 's1', true")).rejects.toThrow();
    await expect(ins(raw, "cta_kind, cta_target_id, sponsor_ref", "'store', 's1', 'ads:1234'")).rejects.toThrow();
    await expect(ins(raw, "cta_kind, cta_target_id, image_key", "'store', 's1', 'https://cdn.example/a'")).rejects.toThrow();
    await expect(ins(raw, "cta_kind, cta_target_id, title_en", `'store', 's1', '${"x".repeat(61)}'`)).rejects.toThrow();
    await expect(raw.exec(`INSERT INTO home_banners (id, title_ar, starts_at, ends_at, created_by, updated_by, cta_kind, cta_target_id) VALUES (gen_random_uuid(), '', '2026-10-12T10:00:00Z', '2026-10-13T10:00:00Z', gen_random_uuid(), gen_random_uuid(), 'store', 's')`)).rejects.toThrow();
  });

  it("shows only scheduled rows to non-admin roles and restricts writes", async () => {
    const { store, raw } = await fresh();
    await store.insert(banner(1));
    await store.insert(banner(2, { status: "paused" }));
    const as = async (role: string | null, sqlText: string) => {
      await raw.exec("BEGIN");
      await raw.exec("SET LOCAL ROLE app_user");
      if (role !== null) await raw.query("SELECT set_config('app.role', $1, true)", [role]);
      try {
        const r = await raw.query<{ n: number }>(sqlText);
        await raw.exec("COMMIT");
        return r.rows[0]?.n;
      } catch (e) {
        await raw.exec("ROLLBACK");
        throw e;
      }
    };
    const count = "SELECT count(*)::int AS n FROM home_banners";
    expect(await as("buyer", count)).toBe(1);
    expect(await as(null, count)).toBe(1);
    expect(await as("marketing", count)).toBe(2);
    expect(await as("support", count)).toBe(1);
    await expect(
      as("buyer", `WITH i AS (INSERT INTO home_banners (id, title_ar, starts_at, ends_at, created_by, updated_by, cta_kind, cta_target_id) VALUES (gen_random_uuid(), 'x', now(), now() + interval '1 day', gen_random_uuid(), gen_random_uuid(), 'store', 's') RETURNING 1) SELECT count(*)::int AS n FROM i`),
    ).rejects.toThrow();
    expect(await as("marketing", `WITH i AS (INSERT INTO home_banners (id, title_ar, starts_at, ends_at, created_by, updated_by, cta_kind, cta_target_id) VALUES (gen_random_uuid(), 'x', now(), now() + interval '1 day', gen_random_uuid(), gen_random_uuid(), 'store', 's') RETURNING 1) SELECT count(*)::int AS n FROM i`)).toBe(1);
    void NOW;
    void H;
  });
});
