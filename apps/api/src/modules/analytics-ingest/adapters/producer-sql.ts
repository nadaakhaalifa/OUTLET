import { sql, type QueryExecutorProvider } from "kysely";
import type { AnalyticsOutboxDraft } from "../domain/events";

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * Appends analytics drafts to `outbox_events` on the CALLER's transaction handle, so the event
 * commits or rolls back with the state change. The deterministic id makes a repeat a no-op.
 */
export async function appendAnalyticsDrafts(trx: QueryExecutorProvider, drafts: readonly AnalyticsOutboxDraft[]): Promise<void> {
  for (const d of drafts) {
    await sql`
      insert into outbox_events (id, occurred_at, aggregate_type, aggregate_id, event_type, ordering_key, payload)
      values (${d.id}::uuid, ${iso(d.occurredAtMs)}::timestamptz, ${d.aggregateType}, ${d.aggregateId}::uuid,
              ${d.type}, ${`${d.aggregateType}:${d.aggregateId}`}, ${JSON.stringify(d.payload)}::jsonb)
      on conflict (id) do nothing`.execute(trx);
  }
}

/**
 * Current `analytics` consent of a user, read uncached from the consent projection on the caller's
 * transaction. No row means not consented (never pre-ticked).
 */
export async function analyticsConsentGranted(trx: QueryExecutorProvider, userId: string): Promise<boolean> {
  const r = await sql<{ granted: boolean }>`
    select granted from consents_current
     where subject_type = 'user' and subject_id = ${userId}::uuid and purpose = 'analytics'`.execute(trx);
  return r.rows[0]?.granted === true;
}
