import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTestDatabaseUpTo } from "@outlet/db";
import { afterAll } from "vitest";
import { createPgliteDatabase, type PgliteInstance } from "../../../platform/db";
import { describeAnalyticsStoreContract } from "../test/repository-contract";
import { KyselySellerAnalyticsStore, type SellerAnalyticsDb } from "./kysely-store";

const SQL = readFileSync(
  fileURLToPath(new URL("../../../../../../packages/db/migrations/0028_seller_analytics.sql", import.meta.url)),
  "utf8",
);
const open: SellerAnalyticsDb[] = [];

/** 0028 depends only on 0001-0011 (helpers, inbox, RLS roles): other modules' migrations cannot break it. */
const fresh = async () => {
  const raw = await createTestDatabaseUpTo(11);
  await raw.exec(SQL);
  const db: SellerAnalyticsDb = createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance);
  open.push(db);
  return { store: new KyselySellerAnalyticsStore(db) };
};

afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

describeAnalyticsStoreContract("kysely/pglite", fresh);
