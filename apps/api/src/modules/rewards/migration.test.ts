import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintMigration } from "@outlet/db";
import { createRewardsDatabase, migrationSql, type PgliteLike } from "./test/pglite-db";
import type { RewardsDb } from "./adapters/kysely-store";

const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let pg: PgliteLike;
let db: RewardsDb;

beforeAll(async () => {
  ({ pg, db } = await createRewardsDatabase());
  await pg.query(`insert into users (id, status) values ($1,'active')`, [U(1)]);
}, 60_000);
afterAll(async () => {
  await db.destroy();
});

describe("0041_rewards", () => {
  it("passes the migration linter", () => {
    expect(lintMigration(migrationSql("0041_rewards.sql"))).toEqual([]);
  });

  it("is expand only: new tables, no DROP and no ALTER of existing ones", () => {
    const sql = readFileSync(new URL("../../../../../packages/db/migrations/0041_rewards.sql", import.meta.url), "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/\bALTER TABLE (?!\w+ ENABLE ROW LEVEL SECURITY)/i);
  });

  it("has no column that could hold cash and no rating column", async () => {
    const r = await pg.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
       where table_name in ('coin_events','coin_debts','spend_events','tier_status','challenges','game_plays','game_odds_versions','game_entitlements')`,
    );
    expect(r.rows.filter((c) => /cash|rating|stars/.test(c.column_name))).toEqual([]);
  });

  it("keeps odds versions immutable for the application role", async () => {
    await pg.exec(`set role app_user; select set_config('app.role','system', false);`);
    try {
      await pg.query(
        `insert into game_odds_versions (id, game, version, odds, published_at, effective_from, approval_id)
         values ($1,'daily_spin',1,'[]'::jsonb, now(), now(), 'a')`,
        [U(50)],
      );
      await expect(pg.query(`update game_odds_versions set odds = '[1]'::jsonb`)).rejects.toThrow(/permission denied/);
      await expect(pg.query(`delete from game_odds_versions`)).rejects.toThrow(/permission denied/);
      await expect(pg.query(`update coin_events set amount = 1`)).rejects.toThrow(/permission denied/);
      await expect(pg.query(`delete from coin_events`)).rejects.toThrow(/permission denied/);
    } finally {
      await pg.exec(`reset role`);
    }
  });

  it("refuses a second play for the same user, game and day sequence and a fourth daily slot", async () => {
    await pg.query(
      `insert into game_plays (id, user_id, game, intent_id, day_key, seq, odds_version_id, roll_ppm, outcome_id, outcome_kind, server_seed, server_seed_hash)
       values ($1,$2,'daily_spin','intent-aaaaaaaa','2027-02-01',1,$3,1,'n','nothing',$4,$4)`,
      [U(60), U(1), U(50), "a".repeat(64)],
    );
    await expect(
      pg.query(
        `insert into game_plays (id, user_id, game, intent_id, day_key, seq, odds_version_id, roll_ppm, outcome_id, outcome_kind, server_seed, server_seed_hash)
         values ($1,$2,'daily_spin','intent-bbbbbbbb','2027-02-01',1,$3,1,'n','nothing',$4,$4)`,
        [U(61), U(1), U(50), "a".repeat(64)],
      ),
    ).rejects.toThrow(/unique/);
    await expect(
      pg.query(
        `insert into game_plays (id, user_id, game, intent_id, day_key, seq, odds_version_id, roll_ppm, outcome_id, outcome_kind, server_seed, server_seed_hash)
         values ($1,$2,'daily_spin','intent-cccccccc','2027-02-01',4,$3,1,'n','nothing',$4,$4)`,
        [U(62), U(1), U(50), "a".repeat(64)],
      ),
    ).rejects.toThrow(/check/);
  });
});
