import { afterAll } from "vitest";
import { createPgliteDatabase, type PgliteInstance } from "../../../platform/db";
import { createRollupDatabase } from "../test/rollup-db";
import { describeAnalyticsStoreContract } from "../test/repository-contract";
import { KyselySellerAnalyticsStore, type SellerAnalyticsDb } from "./kysely-store";

const open: SellerAnalyticsDb[] = [];

/** 0028, 0088 and 0090 depend only on 0001-0011 (helpers, inbox, RLS roles): other modules' migrations cannot break them. */
const fresh = async () => {
  const raw = await createRollupDatabase();
  const db: SellerAnalyticsDb = createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance);
  open.push(db);
  return { store: new KyselySellerAnalyticsStore(db) };
};

afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

describeAnalyticsStoreContract("kysely/pglite", fresh);
