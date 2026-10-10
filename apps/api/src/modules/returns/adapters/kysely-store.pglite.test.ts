import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTestDatabaseUpTo } from "@outlet/db";
import { afterAll } from "vitest";
import { createPgliteDatabase, type PgliteInstance } from "../../../platform/db";
import { describeReturnRepositoryContract } from "../test/repository-contract";
import { KyselyReturnRepository, type ReturnsDb } from "./kysely-store";

const SQL = readFileSync(
  fileURLToPath(new URL("../../../../../../packages/db/migrations/0020_returns.sql", import.meta.url)),
  "utf8",
);
const open: ReturnsDb[] = [];

/** 0020 depends only on 0001-0011 (users), so another module's in-flight migration cannot break this suite. */
const fresh = async () => {
  const raw = await createTestDatabaseUpTo(11);
  await raw.exec(SQL);
  const db: ReturnsDb = createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance);
  open.push(db);
  return {
    repo: new KyselyReturnRepository(db),
    ensureUser: async (id: string) => {
      await raw.query(`insert into users (id, status) values ($1, 'active') on conflict do nothing`, [id]);
    },
  };
};

afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

describeReturnRepositoryContract("kysely/pglite", fresh);
