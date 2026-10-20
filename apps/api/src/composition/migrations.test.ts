import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTestDatabaseUpTo, lintMigration } from "@outlet/db";
import { describe, expect, it } from "vitest";

const DIR = fileURLToPath(new URL("../../../../packages/db/migrations/", import.meta.url));

describe("wave 4 money migrations 0031 to 0035", () => {
  const files = readdirSync(DIR)
    .filter((f) => /^003[1-5]_/.test(f))
    .sort();

  it("are five contiguous files that follow 0030", () => {
    expect(files.map((f) => f.slice(0, 4))).toEqual(["0031", "0032", "0033", "0034", "0035"]);
    expect(readdirSync(DIR).some((f) => f.startsWith("0030_"))).toBe(true);
  });

  it("pass the expand-only linter", () => {
    for (const f of files) expect(lintMigration(readFileSync(DIR + f, "utf8")), f).toEqual([]);
  });

  it("apply in order on a fresh database and leave the ledger posting chain and payment tables in place", async () => {
    const db = await createTestDatabaseUpTo(35);
    try {
      const r = await db.query<{ table_name: string }>(
        `select table_name from information_schema.tables where table_schema = 'public'
         and table_name in ('ledger_entry_chain','payment_intents','checkout_sagas','refunds','credit_lots','payouts','settlement_files')
         order by 1`,
      );
      expect(r.rows.map((x) => x.table_name)).toEqual([
        "checkout_sagas",
        "credit_lots",
        "ledger_entry_chain",
        "payment_intents",
        "payouts",
        "refunds",
        "settlement_files",
      ]);
    } finally {
      await db.close();
    }
  }, 120_000);
});
