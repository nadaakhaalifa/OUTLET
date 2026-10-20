import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintMigration } from "@outlet/db";
import { createReviewDatabase, migrationSql, type PgliteLike } from "./test/pglite-db";
import type { ReviewDb } from "./adapters/kysely-store";

const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let pg: PgliteLike;
let db: ReviewDb;

beforeAll(async () => {
  ({ pg, db } = await createReviewDatabase());
  await pg.query(`insert into users (id, status) values ($1,'active'), ($2,'active')`, [U(1), U(2)]);
}, 60_000);
afterAll(async () => {
  await db.destroy();
});

const review = (id: number, line: number, extra = ""): Promise<unknown> =>
  pg.query(
    `insert into reviews (id, order_line_id, user_id, store_id, product_id, rating, body, status ${extra ? "," + extra.split("=")[0] : ""})
     values ($1,$2,$3,$4,$5,4,'A body that is long enough','SUBMITTED' ${extra ? "," + extra.split("=")[1] : ""})`,
    [U(id), U(line), U(1), U(9001), U(7001)],
  );

describe("0030_reviews", () => {
  it("passes the migration linter", () => {
    expect(lintMigration(migrationSql("0030_reviews.sql"))).toEqual([]);
  });

  it("is expand only: new tables, no ALTER or DROP of existing ones", () => {
    const sql = readFileSync(new URL("../../../../../packages/db/migrations/0030_reviews.sql", import.meta.url), "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/\bALTER TABLE (?!\w+ ENABLE ROW LEVEL SECURITY)/i);
  });

  it("has no column that could hold a rating dependent reward", async () => {
    const r = await pg.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'reviews'`,
    );
    const cols = r.rows.map((x) => x.column_name);
    expect(cols).toContain("reward_intent_at");
    expect(cols.filter((c) => /coin|reward_amount|points|bonus/.test(c))).toEqual([]);
  });

  it("keeps moderation_log append only for the application role", async () => {
    await pg.exec(`set role app_user; select set_config('app.role','system', false);`);
    try {
      await pg.query(
        `insert into moderation_log (id, target_type, target_id, from_status, to_status, actor_kind) values ($1,'review',$2,'SUBMITTED','AUTO_CHECKED','system')`,
        [U(1), U(2)],
      );
      await expect(pg.query(`update moderation_log set reason = 'x'`)).rejects.toThrow(/permission denied/);
      await expect(pg.query(`delete from moderation_log`)).rejects.toThrow(/permission denied/);
    } finally {
      await pg.exec(`reset role`);
    }
  });

  it("refuses duplicate reviews per order line and checks the photo array size", async () => {
    await review(1, 1);
    await expect(review(2, 1)).rejects.toThrow(/reviews_order_line_uq|unique/);
    await expect(review(3, 3, `photo_ids='[1,2,3,4,5,6]'::jsonb`)).rejects.toThrow(/check/);
  });
});
