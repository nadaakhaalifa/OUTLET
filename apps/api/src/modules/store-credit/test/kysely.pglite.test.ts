import { createTestDatabaseUpTo } from "@outlet/db";
import type { Kysely } from "kysely";
import { afterAll } from "vitest";
import { createPgliteDatabase, type PgliteInstance } from "../../../platform/db";
import { KyselyStoreCredit, type StoreCreditDb } from "../adapters/kysely-store";
import { describeStoreCreditSuite } from "./suite";

const open: Kysely<Record<string, never>>[] = [];

describeStoreCreditSuite("kysely/pglite", async () => {
  const raw = await createTestDatabaseUpTo(34);
  const db: StoreCreditDb = createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance);
  open.push(db);
  return {
    store: new KyselyStoreCredit(db),
    ensureUser: async (id: string) => {
      await raw.query(`insert into users (id, status) values ($1, 'active') on conflict do nothing`, [id]);
    },
  };
});

afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});
