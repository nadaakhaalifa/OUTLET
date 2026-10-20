import { createTestDatabaseUpTo } from "@outlet/db";

/** Platform baseline: migrations 0001..0011 (outbox relay columns, saga, ledger owner). */
export const PLATFORM_BASELINE_MIGRATION = 11;
import type { Kysely } from "kysely";
import type { Clock, IdGenerator } from "../ports";
import { createIdGenerator } from "../system-adapters";
import { createPgliteDatabase, type PgliteInstance } from "./factory";
import { KyselyOutboxStore, KyselyInboxStore } from "./outbox-store";
import type { PlatformTables } from "./schema";
import { KyselyTransactionRunner } from "./unit-of-work";

export class TestClock implements Clock {
  public constructor(private ms = 1_800_000_000_000) {}
  public nowMs(): number {
    return this.ms;
  }
  public advance(ms: number): void {
    this.ms += ms;
  }
}

/**
 * Fully migrated in-memory database plus the platform persistence wiring.
 * `raw` is the PGlite superuser handle: use it to ARRANGE and to ASSERT past
 * RLS. Never call `raw` while a transaction callback is running (one connection).
 */
export const createPersistenceFixture = async (opts: { csprng?: Parameters<typeof createIdGenerator>[1] } = {}) => {
  const raw = await createTestDatabaseUpTo(PLATFORM_BASELINE_MIGRATION);
  const pglite = raw as unknown as PgliteInstance;
  const db: Kysely<PlatformTables> = createPgliteDatabase<PlatformTables>(pglite);
  const clock = new TestClock();
  let n = 0;
  const ids: IdGenerator = opts.csprng
    ? createIdGenerator(clock, opts.csprng)
    : {
        uuidV7: () => `0192f3a4-5b6c-7d8e-9f01-${String(++n).padStart(12, "0")}`,
        hex: (bytes) => "ab".repeat(bytes),
      };
  const outbox = new KyselyOutboxStore(db);
  const inbox = new KyselyInboxStore();
  const runner = new KyselyTransactionRunner<PlatformTables>({ db, outbox, clock, ids });
  return { raw, db, clock, ids, outbox, inbox, runner, close: () => db.destroy() };
};
export type PersistenceFixture = Awaited<ReturnType<typeof createPersistenceFixture>>;
