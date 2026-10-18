import { sql, type Kysely } from "kysely";
import type { AnalyticsOutboxDraft } from "../domain/events";
import type { BatchOutbox, ConsentReader } from "../domain/ports";
import { analyticsConsentGranted, appendAnalyticsDrafts } from "./producer-sql";

export type IngestDb = Kysely<Record<string, never>>;

/** Uncached read of `consents_current` (an indexed read) under the system role. */
export class KyselyConsentReader implements ConsentReader {
  constructor(private readonly db: IngestDb) {}
  async analyticsConsent(userId: string): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      return analyticsConsentGranted(trx, userId);
    });
  }
}

/** One outbox row per accepted batch. The only write ingest performs. */
export class KyselyBatchOutbox implements BatchOutbox {
  constructor(private readonly db: IngestDb) {}
  async append(draft: AnalyticsOutboxDraft): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      await appendAnalyticsDrafts(trx, [draft]);
    });
  }
}
