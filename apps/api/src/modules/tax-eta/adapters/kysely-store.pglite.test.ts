import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTestDatabaseUpTo } from "@outlet/db";
import { afterAll } from "vitest";
import { createPgliteDatabase, type PgliteInstance } from "../../../platform/db";
import { describeTaxRepositoryContract } from "../test/repository-contract";
import {
  KyselySignedDocumentStore,
  KyselyTaxConfigRepository,
  KyselyTaxDocumentRepository,
  type TaxEtaDb,
} from "./kysely-store";

const SQL = readFileSync(
  fileURLToPath(new URL("../../../../../../packages/db/migrations/0027_tax_eta.sql", import.meta.url)),
  "utf8",
);
const open: TaxEtaDb[] = [];

/** 0027 depends only on 0001-0011 (users, helpers, append-only guard). */
const fresh = async () => {
  const raw = await createTestDatabaseUpTo(11);
  await raw.exec(SQL);
  const db: TaxEtaDb = createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance);
  open.push(db);
  return {
    config: new KyselyTaxConfigRepository(db),
    documents: new KyselyTaxDocumentRepository(db),
    signed: new KyselySignedDocumentStore(db),
    ensureUser: async (id: string) => {
      await raw.query(`insert into users (id, status) values ($1, 'active') on conflict do nothing`, [id]);
    },
  };
};

afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

describeTaxRepositoryContract("kysely/pglite", fresh);
