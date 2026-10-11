import { createTestDatabaseUpTo } from "@outlet/db";
import type { RlsSession } from "../../../platform/db";
import { KyselyOutboxStore, KyselyTransactionRunner, createPgliteDatabase, type PgliteInstance } from "../../../platform/db";
import { TestClock } from "../../../platform/db/test-support";
import {
  KyselyFavoriteRepository,
  KyselyStoreActivityFeed,
  KyselyStoreRepository,
  SYSTEM_SESSION,
  type StoresDb,
} from "../adapters/kysely";
import type { StoresContractHarness } from "./contract/repositories.contract";

export interface StoresPglite extends StoresContractHarness {
  readonly raw: Awaited<ReturnType<typeof createTestDatabaseUpTo>>;
  readonly stores: KyselyStoreRepository;
  readonly favorites: KyselyFavoriteRepository;
  readonly feed: KyselyStoreActivityFeed;
  /** Runner and session holder, for booting the Nest module on this database. */
  readonly runner: KyselyTransactionRunner<StoresDb>;
  readonly session: () => RlsSession;
  setSession(s: RlsSession): void;
}

/** Migrations 0001..0013 on PGlite, runner dropping to `app_user` so RLS applies. */
export async function createStoresPglite(): Promise<StoresPglite> {
  const raw = await createTestDatabaseUpTo(13);
  const db = createPgliteDatabase<StoresDb>(raw as unknown as PgliteInstance);
  let n = 0;
  const runner = new KyselyTransactionRunner<StoresDb>({
    db,
    outbox: new KyselyOutboxStore(db),
    clock: new TestClock(),
    ids: { uuidV7: () => `0192f3a4-5b6c-7d8e-9f01-${String((n += 1)).padStart(12, "0")}`, hex: (b) => "ab".repeat(b) },
  });
  let current: RlsSession = SYSTEM_SESSION;
  const session = (): RlsSession => current;
  const feed = new KyselyStoreActivityFeed(runner, session);
  return {
    raw,
    runner,
    session,
    stores: new KyselyStoreRepository(runner, session),
    favorites: new KyselyFavoriteRepository(runner, session),
    feed,
    setSession: (s) => {
      current = s;
    },
    recordActivity: (storeId, ms) => feed.record(storeId, "product_published", ms),
    addUser: async (id) => {
      await raw.query(`INSERT INTO users (id, status) VALUES ($1, 'active') ON CONFLICT DO NOTHING`, [id]);
    },
    close: async () => {
      await db.destroy();
    },
  };
}
