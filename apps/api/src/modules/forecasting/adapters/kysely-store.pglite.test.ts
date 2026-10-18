import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTestDatabaseUpTo } from "@outlet/db";
import { afterAll } from "vitest";
import { createPgliteDatabase, type PgliteInstance } from "../../../platform/db";
import { describeForecastStoreContract } from "../test/repository-contract";
import { KyselyForecastStore, type ForecastingDb } from "./kysely-store";

const read = (f: string) =>
  readFileSync(fileURLToPath(new URL(`../../../../../../packages/db/migrations/${f}`, import.meta.url)), "utf8");
const open: ForecastingDb[] = [];

/** 0064 and 0065 depend only on 0001-0011 (helpers, RLS roles): other modules' migrations cannot break them. */
const fresh = async () => {
  const raw = await createTestDatabaseUpTo(11);
  await raw.exec(read("0064_demand_forecasting.sql"));
  await raw.exec(read("0065_forecast_runs.sql"));
  const db: ForecastingDb = createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance);
  open.push(db);
  return { store: new KyselyForecastStore(db) };
};

afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

describeForecastStoreContract("kysely/pglite", fresh);
