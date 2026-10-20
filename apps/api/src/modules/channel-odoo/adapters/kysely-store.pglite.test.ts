import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTestDatabaseUpTo } from "@outlet/db";
import { afterAll } from "vitest";
import { createPgliteDatabase, type PgliteInstance } from "../../../platform/db";
import { describeOdooStoreContract } from "../test/repository-contract";
import { KyselyOdooStore, type OdooDb } from "./kysely-store";

const read = (f: string) => readFileSync(fileURLToPath(new URL(`../../../../../../packages/db/migrations/${f}`, import.meta.url)), "utf8");
const open: OdooDb[] = [];

/** 0024 (price_events), 0043 (channels, targets) and 0071 depend only on the helpers and RLS roles of 0001-0011. */
const fresh = async () => {
  const raw = await createTestDatabaseUpTo(11);
  await raw.exec(read("0024_price_integrity.sql"));
  await raw.exec(read("0043_price_crawler.sql"));
  await raw.exec(read("0071_odoo_channel.sql"));
  const db: OdooDb = createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance);
  open.push(db);
  return {
    store: new KyselyOdooStore(db),
    seed: async (channelId: string, storeId: string, targetId: string) => {
      await raw.query(
        `INSERT INTO crawl_targets (id, store_id, domain, status, verification_method, verification_token_hash, consent_at, verified_at)
         VALUES ($1, $2, $3, 'verified', 'dns_txt', repeat('a', 64), now(), now()) ON CONFLICT DO NOTHING`,
        [targetId, storeId, `odoo-${targetId.slice(-4)}.example.com`],
      );
      await raw.query(
        `INSERT INTO channel_connections (id, store_id, kind, status, token_ref, kms_key_ref, target_id)
         VALUES ($1, $2, 'odoo', 'active', 'vault://odoo/x1', 'kms://key/x1', NULL) ON CONFLICT DO NOTHING`,
        [channelId, storeId],
      );
    },
  };
};

afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

describeOdooStoreContract("kysely/pglite", fresh);
