import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTestDatabaseUpTo } from "@outlet/db";
import { afterAll, describe, expect, it } from "vitest";
import { createPgliteDatabase, type PgliteInstance } from "../../../platform/db";
import { describeSettingsRepository, STORE_A, STORE_B } from "../test/repository-contract";
import { KyselySettingsRepository, type SettingsDb } from "./kysely-store";

const MIGRATION = fileURLToPath(new URL("../../../../../../packages/db/migrations/0055_seller_settings.sql", import.meta.url));
const open: SettingsDb[] = [];

const freshDb = async () => {
  const raw = await createTestDatabaseUpTo(11);
  await raw.exec(readFileSync(MIGRATION, "utf8"));
  const db: SettingsDb = createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance);
  open.push(db);
  return { raw, db };
};

afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

describeSettingsRepository("kysely/pglite", async () => new KyselySettingsRepository((await freshDb()).db));

describe("migration 0055 guards", () => {
  it("rejects return windows below the statutory minimum and English-only policy text", async () => {
    const { raw } = await freshDb();
    const ins = (days: number, defect: number, ar: string | null, en: string | null) =>
      raw.query(
        `insert into seller_store_profiles (store_id, display_name_ar, return_change_of_mind_days, return_defect_days, return_policy_ar, return_policy_en)
         values ($1, 'متجر', $2, $3, $4, $5)`,
        [STORE_A, days, defect, ar, en],
      );
    await expect(ins(13, 30, null, null)).rejects.toThrow();
    await expect(ins(14, 29, null, null)).rejects.toThrow();
    await expect(ins(14, 30, null, "English only")).rejects.toThrow();
    await ins(14, 30, "عربي", "English");
  });

  it("settings events are append-only", async () => {
    const repo = new KyselySettingsRepository((await freshDb()).db);
    await repo.addEvent({ id: "0192f3a4-5b6c-7d8e-9f01-000000000001", storeId: STORE_B, area: "eta", kind: "eta.requested", actorId: null, occurredAtMs: 1_700_000_000_000, detail: {} });
    const { raw } = await freshDb();
    await raw.query(`insert into seller_settings_events (id, store_id, area, kind) values ($1, $2, 'eta', 'eta.requested')`, [
      "0192f3a4-5b6c-7d8e-9f01-000000000002",
      STORE_B,
    ]);
    await expect(raw.query(`update seller_settings_events set kind = 'x.y.z'`)).rejects.toThrow(/append-only/);
    await expect(raw.query(`delete from seller_settings_events`)).rejects.toThrow(/append-only/);
  });

  it("a second ACTIVE payout account for a store is impossible at the database level", async () => {
    const { raw } = await freshDb();
    const ins = (id: string, tok: string) =>
      raw.query(
        `insert into seller_payout_accounts (id, store_id, account_token, iban_enc, iban_last4, holder_name_enc, legal_name_score, created_by, activates_at)
         values ($1, $2, $3, '\\x01', '0001', '\\x02', 100, $1, now())`,
        [id, STORE_A, tok],
      );
    await ins("0192f3a4-5b6c-7d8e-9f01-000000000001", `acct_${"a".repeat(32)}`);
    await expect(ins("0192f3a4-5b6c-7d8e-9f01-000000000002", `acct_${"b".repeat(32)}`)).rejects.toThrow();
  });
});
