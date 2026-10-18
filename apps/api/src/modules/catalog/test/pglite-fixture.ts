import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTestDatabaseUpTo } from "@outlet/db";
import type { RlsSession } from "../../../platform/db";
import {
  KyselyOutboxStore,
  KyselyTransactionRunner,
  createPgliteDatabase,
  type PgliteInstance,
} from "../../../platform/db";
import { TestClock } from "../../../platform/db/test-support";
import type { CatalogDb } from "../adapters/kysely";
import { SYSTEM_SESSION, type SessionProvider } from "../adapters/kysely";
import { KyselyImportRepository, KyselyProductRepository, KyselyTaxonomy } from "../adapters/kysely";
import { SEED, SEED_BRANDS, SEED_CATEGORIES } from "../adapters/in-memory";
import type { CatalogContractHarness } from "./contract/repositories.contract";

/** Migrations 0001..0013 (catalog 0012, real `stores` 0013), then 0083 + 0085 + 0086 (department; job link: product_media.media_job_id, needs the jobs table). */
export const CATALOG_MIGRATION_CEILING = 13;

export interface CatalogPglite extends CatalogContractHarness {
  readonly raw: Awaited<ReturnType<typeof createTestDatabaseUpTo>>;
  readonly runner: KyselyTransactionRunner<CatalogDb>;
  readonly session: SessionProvider;
  /** Identity used for the next transaction. Starts as `system`. */
  setSession(s: RlsSession): void;
  readonly products: KyselyProductRepository;
  readonly taxonomy: KyselyTaxonomy;
  readonly imports: KyselyImportRepository;
}

export async function createCatalogPglite(): Promise<CatalogPglite> {
  const raw = await createTestDatabaseUpTo(CATALOG_MIGRATION_CEILING);
  for (const f of ["0083_product_media.sql", "0085_product_media_attach.sql", "0086_product_department.sql"]) {
    await raw.exec(readFileSync(fileURLToPath(new URL(`../../../../../../packages/db/migrations/${f}`, import.meta.url)), "utf8"));
  }
  const db = createPgliteDatabase<CatalogDb>(raw as unknown as PgliteInstance);
  let n = 0;
  const runner = new KyselyTransactionRunner<CatalogDb>({
    db,
    outbox: new KyselyOutboxStore(db),
    clock: new TestClock(),
    ids: { uuidV7: () => `0192f3a4-5b6c-7d8e-9f01-${String((n += 1)).padStart(12, "0")}`, hex: (b) => "ab".repeat(b) },
  });
  let current: RlsSession = SYSTEM_SESSION;
  const session: SessionProvider = () => current;

  // Arrange as the superuser handle (before any app_user transaction).
  for (const c of SEED_CATEGORIES) {
    await raw.query(
      `INSERT INTO categories (id, slug, name_ar, name_en, product_type, return_class, requires_size_chart, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [c.id, c.slug, c.nameAr, c.nameEn ?? null, c.productType, c.returnClass, c.requiresSizeChart, c.active],
    );
  }
  for (const b of SEED_BRANDS) {
    await raw.query(`INSERT INTO brands (id, slug, name_ar, name_en) VALUES ($1,$2,$3,$4)`, [b.id, b.slug, b.nameAr, b.nameEn ?? null]);
  }
  void SEED;
  return {
    raw,
    runner,
    session,
    setSession: (s) => {
      current = s;
    },
    products: new KyselyProductRepository(runner, session),
    taxonomy: new KyselyTaxonomy(runner, session),
    imports: new KyselyImportRepository(runner, session),
    close: async () => {
      await db.destroy();
    },
  };
}
