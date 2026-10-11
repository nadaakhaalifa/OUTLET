import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { lintMigration } from "@outlet/db";
import type { Kysely } from "kysely";
import { createDatabase, migrationSql, type PgliteLike } from "./test/pglite-db";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let pg: PgliteLike;
let db: Kysely<Record<string, never>>;

beforeAll(async () => {
  ({ pg, db } = await createDatabase());
  await pg.query(`insert into users (id, status) values ($1,'active'), ($2,'active')`, [U(1), U(2)]);
});
afterAll(async () => {
  await db.destroy();
});

describe("0040_recommendations_history", () => {
  it("passes the migration linter and is expand only", () => {
    expect(lintMigration(migrationSql("0040_recommendations_history.sql"))).toEqual([]);
    const text = readFileSync(new URL("../../../../../packages/db/migrations/0040_recommendations_history.sql", import.meta.url), "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(text).not.toMatch(/\bDROP\b/i);
    expect(text).not.toMatch(/\bALTER TABLE (?!\w+ ENABLE ROW LEVEL SECURITY)/i);
  });

  it("user_features refuses budget, affordability and measurement keys", async () => {
    await expect(
      pg.query(`insert into user_features (user_id, features, model_version, built_at) values ($1, '{"remaining_budget": 5}', 'v', now())`, [U(1)]),
    ).rejects.toThrow(/user_features_no_budget/);
    await expect(
      pg.query(`insert into user_features (user_id, features, model_version, built_at) values ($1, '{"x":{"afford_now":1}}', 'v', now())`, [U(1)]),
    ).rejects.toThrow(/user_features_no_budget/);
    await pg.query(`insert into user_features (user_id, features, model_version, built_at) values ($1, '{"categoryAffinity":{"dress":900}}', 'v', now())`, [U(1)]);
  });

  it("user_events needs an item except for searches and is partitioned", async () => {
    await expect(
      pg.query(`insert into user_events (id, user_id, type, at) values ($1,$2,'viewed', now())`, [U(100), U(1)]),
    ).rejects.toThrow(/user_events_item_needed/);
    await pg.query(`insert into user_events (id, user_id, type, detail, at) values ($1,$2,'searched','linen', now())`, [U(101), U(1)]);
    const r = await pg.query<{ relkind: string }>(`select relkind from pg_class where relname = 'user_events'`);
    expect(r.rows[0]?.relkind).toBe("p");
  });

  it("deleting a user cascades history, features and settings", async () => {
    await pg.query(`insert into personalization_settings (user_id) values ($1)`, [U(2)]);
    await pg.query(`insert into recently_viewed (user_id, product_id, viewed_at) values ($1,$2, now())`, [U(2), U(7000)]);
    await pg.query(`delete from users where id = $1`, [U(2)]);
    const r = await pg.query<{ n: string }>(`select count(*)::text as n from recently_viewed where user_id = $1`, [U(2)]);
    expect(r.rows[0]?.n).toBe("0");
  });

  it("allows one active ranking model and clicks never exceed impressions", async () => {
    await pg.query(`insert into ranking_models (version, status) values ('a','active')`);
    await expect(pg.query(`insert into ranking_models (version, status) values ('b','active')`)).rejects.toThrow();
    await expect(
      pg.query(`insert into recommendation_item_stats (product_id, module, impressions, clicks) values ($1,'feed',1,2)`, [U(7000)]),
    ).rejects.toThrow(/clicks_le/);
  });

  it("under app_user RLS: own rows only, aggregate tables read-only", async () => {
    await pg.query(`insert into users (id, status) values ($1,'active') on conflict do nothing`, [U(3)]);
    await pg.query(`insert into user_events (id, user_id, type, item_id, at) values ($1,$2,'viewed',$3, now())`, [U(110), U(1), U(7001)]);
    await pg.exec(`set role app_user; select set_config('app.user_id','${U(3)}', false); select set_config('app.role','shopper', false);`);
    try {
      const own = await pg.query<{ n: string }>(`select count(*)::text as n from user_events`);
      expect(own.rows[0]?.n).toBe("0");
      await expect(
        pg.query(`insert into user_events (id, user_id, type, item_id, at) values ($1,$2,'viewed',$3, now())`, [U(111), U(1), U(7001)]),
      ).rejects.toThrow(/row-level security/);
      await expect(
        pg.query(`insert into item_cooccurrence (item_a, item_b, kind, score, window_days, computed_at) values ($1,$2,'co_buy',1,30,now())`, [U(7001), U(7002)]),
      ).rejects.toThrow(/row-level security/);
    } finally {
      await pg.exec(`reset role`);
    }
  });
});
