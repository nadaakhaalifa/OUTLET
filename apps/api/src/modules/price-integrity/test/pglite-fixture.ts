import { readFile } from "node:fs/promises";
import { createTestDatabaseUpTo } from "@outlet/db";
import type { RlsSession } from "../../../platform/db";
import { KyselyOutboxStore, KyselyTransactionRunner, createPgliteDatabase, type PgliteInstance } from "../../../platform/db";
import { TestClock } from "../../../platform/db/test-support";
import {
  KyselyClaimStore,
  KyselyEnforcementStore,
  KyselyPriceEventStore,
  SYSTEM_SESSION,
  type PriceIntegrityDb,
  type SessionProvider,
} from "../adapters/kysely";
import type { PriceIntegrityContractHarness } from "./contract";

const MIGRATION = new URL("../../../../../../packages/db/migrations/0024_price_integrity.sql", import.meta.url);

export interface PriceIntegrityPglite extends PriceIntegrityContractHarness {
  readonly raw: Awaited<ReturnType<typeof createTestDatabaseUpTo>>;
  readonly runner: KyselyTransactionRunner<PriceIntegrityDb>;
  readonly session: SessionProvider;
  readonly events: KyselyPriceEventStore;
  readonly claims: KyselyClaimStore;
  readonly enforcement: KyselyEnforcementStore;
  setSession(s: RlsSession): void;
}

/**
 * 0024 needs only the helpers from 0002 (app_role, app_store_ids, forbid_mutation) and the app_user
 * role. The baseline is applied through the real runner and 0024 is applied on top, so a numbering
 * gap in unrelated migrations (0021) cannot break this suite.
 */
export async function createPriceIntegrityPglite(): Promise<PriceIntegrityPglite> {
  const raw = await createTestDatabaseUpTo(11);
  await raw.exec(await readFile(MIGRATION, "utf8"));
  const db = createPgliteDatabase<PriceIntegrityDb>(raw as unknown as PgliteInstance);
  let n = 0;
  const runner = new KyselyTransactionRunner<PriceIntegrityDb>({
    db,
    outbox: new KyselyOutboxStore(db),
    clock: new TestClock(),
    ids: { uuidV7: () => `0192f3a4-5b6c-7d8e-9f01-${String((n += 1)).padStart(12, "0")}`, hex: (b) => "ab".repeat(b) },
  });
  let current: RlsSession = SYSTEM_SESSION;
  const session: SessionProvider = () => current;
  return {
    raw,
    runner,
    session,
    setSession: (s) => {
      current = s;
    },
    events: new KyselyPriceEventStore(runner, session),
    claims: new KyselyClaimStore(runner, session),
    enforcement: new KyselyEnforcementStore(runner, session),
    close: async () => {
      await db.destroy();
    },
  };
}
