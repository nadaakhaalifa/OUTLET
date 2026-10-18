import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintMigration } from "@outlet/db";
import type { AdsDb } from "./adapters/kysely-store";
import { createAdsDatabase, migrationSql, type PgliteLike } from "./test/pglite-db";

const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let pg: PgliteLike;
let db: AdsDb;

beforeAll(async () => {
  ({ pg, db } = await createAdsDatabase());
}, 60_000);
afterAll(async () => {
  await db.destroy();
});

describe("0045_ads", () => {
  it("passes the migration linter and is expand only", () => {
    expect(lintMigration(migrationSql("0045_ads.sql"))).toEqual([]);
    const sql = readFileSync(new URL("../../../../../packages/db/migrations/0045_ads.sql", import.meta.url), "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/\bALTER TABLE (?!\w+ ENABLE ROW LEVEL SECURITY)/i);
  });

  it("has RLS enabled on every ads table", async () => {
    const names = ["ad_config", "ad_campaigns", "ad_product_bids", "ad_balances", "ad_topups", "ad_daily_spend", "ad_impressions", "ad_clicks"];
    const r = await pg.query<{ relname: string; relrowsecurity: boolean }>(`select relname, relrowsecurity from pg_class where relname = any($1)`, [names]);
    expect(r.rows).toHaveLength(names.length);
    expect(r.rows.every((x) => x.relrowsecurity)).toBe(true);
  });

  it("keeps budget words out of campaign keywords and impressions free of any user id", async () => {
    await expect(
      pg.query(
        `insert into ad_campaigns (id, store_id, name, status, daily_budget, max_cpc, keywords, starts_at)
         values ($1,$2,'Bad','ACTIVE',1000,100,'["my budget"]'::jsonb, now())`,
        [U(1), U(2)],
      ),
    ).rejects.toThrow(/check/);
    const cols = await pg.query<{ column_name: string }>(`select column_name from information_schema.columns where table_name = 'ad_impressions'`);
    expect(cols.rows.map((c) => c.column_name)).not.toContain("user_id");
  });

  it("refuses a duplicate click token and a credited-back amount above the cost", async () => {
    await pg.query(
      `insert into ad_campaigns (id, store_id, name, status, daily_budget, max_cpc, starts_at) values ($1,$2,'Ok','ACTIVE',1000,100, now())`,
      [U(10), U(2)],
    );
    const ins = (id: string, extra = "") =>
      pg.query(
        `insert into ad_clicks (id, token_jti, campaign_id, store_id, product_id, impression_id, session_hash, valid, cost, day_key, ts ${extra ? ", credited_back" : ""})
         values ($1,'jti-duplicate-1',$2,$3,$4,$5,$6,true,100,'2026-04-15',now() ${extra ? ", " + extra : ""})`,
        [id, U(10), U(2), U(3), U(4), "a".repeat(64)],
      );
    await ins(U(20));
    await expect(ins(U(21))).rejects.toThrow(/unique|duplicate/);
    await expect(
      pg.query(`update ad_clicks set credited_back = 500 where id = $1`, [U(20)]),
    ).rejects.toThrow(/check/);
  });
});

describe("0048_ad_click_reviews", () => {
  it("passes the migration linter and keeps reviews append-only", async () => {
    expect(lintMigration(migrationSql("0048_ad_click_reviews.sql"))).toEqual([]);
    await pg.query(`insert into ad_click_reviews (click_id, decision, reason_code, decided_by) values ($1,'flag_store','bot_pattern',$2)`, [U(77), U(78)]);
    await expect(pg.query(`update ad_click_reviews set decision = 'confirm_invalid' where click_id = $1`, [U(77)])).rejects.toThrow();
    await expect(pg.query(`insert into ad_click_reviews (click_id, decision, reason_code, decided_by) values ($1,'refund','x1',$2)`, [U(79), U(78)])).rejects.toThrow(/check/);
  });
});
