import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTestDatabaseUpTo } from "@outlet/db";
import { afterAll } from "vitest";
import { createPgliteDatabase, type PgliteInstance } from "../../../platform/db";
import { KyselyRankingStore, type RankingDb } from "../adapters/kysely-store";
import { describeRankingStoreContract } from "./store-contract";

const read = (f: string) =>
  readFileSync(fileURLToPath(new URL(`../../../../../../packages/db/migrations/${f}`, import.meta.url)), "utf8");
const open: RankingDb[] = [];

/** 0079 and 0080 depend only on the helper functions and roles of 0001-0011. */
const fresh = async () => {
  const raw = await createTestDatabaseUpTo(11);
  await raw.exec(read("0079_ranking_v2_shadow.sql"));
  await raw.exec(read("0080_ranking_v2_eval_runs.sql"));
  const db: RankingDb = createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance);
  open.push(db);
  const store = new KyselyRankingStore(db);
  return { shadow: store, evals: store };
};

afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

describeRankingStoreContract("kysely/pglite", fresh);
