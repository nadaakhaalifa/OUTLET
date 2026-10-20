import { sql, type Kysely, type Transaction } from "kysely";
import {
  DuplicateOutboxEventError,
  InvalidReplayError,
  UnknownOutboxEventError,
  type DeadLetterUpdate,
  type FailureUpdate,
  type InboxStore,
  type JsonObject,
  type OutboxRecord,
  type OutboxStore,
} from "./deps";
import type { PlatformTables } from "./schema";
import { applySession, asSystemRole, resolveTxOptions } from "./session";

/** What the outbox and inbox adapters need from a transaction handle (satisfied by `DbTx`). */
export interface PlatformTx {
  readonly platformDb: Transaction<PlatformTables>;
}

const isUniqueViolation = (e: unknown): boolean =>
  typeof e === "object" && e !== null && "code" in e && (e as { code?: unknown }).code === "23505";

const toRecord = (r: {
  id: string;
  occurred_at: Date;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  event_version: number;
  ordering_key: string | null;
  payload: JsonObject;
  headers: JsonObject;
  published_at: Date | null;
  publish_attempts: number;
  last_error: string | null;
  next_attempt_at: Date | null;
  dead_lettered_at: Date | null;
}): OutboxRecord => ({
  id: r.id,
  occurredAt: r.occurred_at,
  aggregateType: r.aggregate_type,
  aggregateId: r.aggregate_id,
  eventType: r.event_type,
  eventVersion: r.event_version,
  orderingKey: r.ordering_key,
  payload: r.payload,
  headers: r.headers,
  publishedAt: r.published_at,
  publishAttempts: r.publish_attempts,
  lastError: r.last_error,
  nextAttemptAt: r.next_attempt_at,
  deadLetteredAt: r.dead_lettered_at,
});

/**
 * Postgres outbox. `append` joins the caller's business transaction. The relay
 * operations each open their own short system-role transaction.
 *
 * Concurrency: claimDue is a plain read. With ONE relay instance this is
 * exact; with several, a record may be published twice. That is allowed
 * (at-least-once, consumers dedupe through the inbox) but wasteful: add a
 * lease column before scaling the relay out. SKIP LOCKED behaviour is NOT
 * verified on PGlite.
 */
export class KyselyOutboxStore implements OutboxStore<PlatformTx> {
  public constructor(
    private readonly db: Kysely<PlatformTables>,
    private readonly applicationRole: string | null = "app_user",
  ) {}

  public async append(tx: PlatformTx, record: OutboxRecord): Promise<void> {
    try {
      // outbox_events policy is system-only today (0007); see ADR-0020 "Open items".
      await asSystemRole(tx.platformDb, () =>
        tx.platformDb
          .insertInto("outbox_events")
          .values({
            id: record.id,
            occurred_at: record.occurredAt,
            aggregate_type: record.aggregateType,
            aggregate_id: record.aggregateId,
            event_type: record.eventType,
            event_version: record.eventVersion,
            ordering_key: record.orderingKey,
            payload: JSON.stringify(record.payload),
            headers: JSON.stringify(record.headers),
          })
          .execute(),
      );
    } catch (e) {
      if (isUniqueViolation(e)) throw new DuplicateOutboxEventError(`outbox event ${record.id} already exists`);
      throw e;
    }
  }

  public async claimDue(now: Date, limit: number): Promise<readonly OutboxRecord[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError("limit must be 1..1000");
    return this.system("outbox.relay", async (trx) => {
      const res = await sql<Parameters<typeof toRecord>[0]>`
        SELECT e.* FROM outbox_events e
        WHERE e.published_at IS NULL
          AND e.dead_lettered_at IS NULL
          AND (e.next_attempt_at IS NULL OR e.next_attempt_at <= ${now})
          AND NOT EXISTS (
            SELECT 1 FROM outbox_events h
            WHERE e.ordering_key IS NOT NULL
              AND h.ordering_key = e.ordering_key
              AND h.published_at IS NULL
              AND (h.occurred_at, h.id) < (e.occurred_at, e.id)
              AND (h.dead_lettered_at IS NOT NULL OR h.next_attempt_at > ${now}))
        ORDER BY e.occurred_at, e.id
        LIMIT ${limit}`.execute(trx);
      return res.rows.map(toRecord);
    });
  }

  public async markPublished(id: string, at: Date): Promise<void> {
    await this.mutate(id, (t) =>
      t.updateTable("outbox_events").set({ published_at: at, last_error: null }).where("id", "=", id).executeTakeFirst(),
    );
  }

  public async recordFailure(id: string, u: FailureUpdate): Promise<void> {
    await this.mutate(id, (t) =>
      t
        .updateTable("outbox_events")
        .set({ publish_attempts: u.attempts, last_error: u.error.slice(0, 500), next_attempt_at: u.nextAttemptAt })
        .where("id", "=", id)
        .executeTakeFirst(),
    );
  }

  public async deadLetter(id: string, u: DeadLetterUpdate): Promise<void> {
    await this.mutate(id, (t) =>
      t
        .updateTable("outbox_events")
        .set({ publish_attempts: u.attempts, last_error: u.error.slice(0, 500), dead_lettered_at: u.at })
        .where("id", "=", id)
        .executeTakeFirst(),
    );
  }

  public async listDeadLettered(limit: number): Promise<readonly OutboxRecord[]> {
    return this.system("outbox.relay", async (trx) => {
      const rows = await trx
        .selectFrom("outbox_events")
        .selectAll()
        .where("dead_lettered_at", "is not", null)
        .where("published_at", "is", null)
        .orderBy("occurred_at")
        .orderBy("id")
        .limit(limit)
        .execute();
      return rows.map(toRecord);
    });
  }

  public async replay(id: string, _at: Date): Promise<void> {
    await this.system("outbox.relay", async (trx) => {
      const row = await trx.selectFrom("outbox_events").select(["dead_lettered_at"]).where("id", "=", id).executeTakeFirst();
      if (row === undefined) throw new UnknownOutboxEventError(`unknown outbox event ${id}`);
      if (row.dead_lettered_at === null) throw new InvalidReplayError(`outbox event ${id} is not dead-lettered`);
      await trx
        .updateTable("outbox_events")
        .set({ dead_lettered_at: null, publish_attempts: 0, next_attempt_at: null })
        .where("id", "=", id)
        .execute();
    });
  }

  private async mutate(
    id: string,
    run: (t: Transaction<PlatformTables>) => Promise<{ numUpdatedRows: bigint } | undefined>,
  ): Promise<void> {
    await this.system("outbox.relay", async (trx) => {
      const r = await run(trx);
      if (r === undefined || r.numUpdatedRows === 0n) throw new UnknownOutboxEventError(`unknown outbox event ${id}`);
    });
  }

  private system<T>(process: string, fn: (t: Transaction<PlatformTables>) => Promise<T>): Promise<T> {
    const resolved = resolveTxOptions({ process, profile: "relay", session: { userId: null, role: "system" } });
    return this.db.transaction().execute(async (trx) => {
      await applySession(trx, resolved, this.applicationRole);
      return fn(trx);
    });
  }
}

/** Idempotent consumer bookkeeping: `INSERT ... ON CONFLICT DO NOTHING`, true when newly recorded. */
export class KyselyInboxStore implements InboxStore<PlatformTx> {
  public async tryRecord(tx: PlatformTx, consumer: string, messageId: string, at: Date): Promise<boolean> {
    // inbox_processed policy is system-only today (0007); see ADR-0020 "Open items".
    return asSystemRole(tx.platformDb, async () => {
      const r = await tx.platformDb
        .insertInto("inbox_processed")
        .values({ consumer, message_id: messageId, processed_at: at })
        .onConflict((oc) => oc.columns(["consumer", "message_id"]).doNothing())
        .executeTakeFirst();
      return r.numInsertedOrUpdatedRows === 1n;
    });
  }
}
