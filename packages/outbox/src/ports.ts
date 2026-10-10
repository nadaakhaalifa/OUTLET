import type { OutboxRecord, JsonObject } from './record.js';

/** Injected clock. Domain and relay code never read the system clock. */
export interface Clock {
  now(): Date;
}

/** Injected randomness: returns a float in [0, 1). Used only for backoff jitter. */
export type Random = () => number;

/**
 * Runs `fn` atomically: either every write made through `tx` is committed, or
 * none is. The SQL adapter maps this to one database transaction.
 */
export interface UnitOfWork<Tx> {
  run<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

/** What a broker receives. `messageId` is the outbox event id and is the inbox dedupe key. */
export interface OutboxMessage {
  readonly messageId: string;
  readonly occurredAt: Date;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly orderingKey: string | null;
  readonly payload: JsonObject;
  readonly headers: JsonObject;
}

/** Broker adapter. Resolve means "the broker accepted it"; reject means "retry later". */
export interface Publisher {
  publish(message: OutboxMessage): Promise<void>;
}

export interface FailureUpdate {
  readonly error: string;
  readonly attempts: number;
  readonly nextAttemptAt: Date;
}

export interface DeadLetterUpdate {
  readonly error: string;
  readonly attempts: number;
  readonly at: Date;
}

/**
 * Persistence for the outbox. `append` takes the caller's transaction so the
 * event commits atomically with the state change. Every other method is the
 * relay's own short operation.
 */
export interface OutboxStore<Tx> {
  /** Insert inside the business transaction. Throws DuplicateOutboxEventError on id clash. */
  append(tx: Tx, record: OutboxRecord): Promise<void>;
  /**
   * Unpublished, non-dead-lettered, due records, oldest first. A record is
   * withheld while an earlier record with the same orderingKey is dead-lettered
   * or not yet due, so per-key order is never inverted.
   */
  claimDue(now: Date, limit: number): Promise<readonly OutboxRecord[]>;
  markPublished(id: string, at: Date): Promise<void>;
  recordFailure(id: string, update: FailureUpdate): Promise<void>;
  deadLetter(id: string, update: DeadLetterUpdate): Promise<void>;
  listDeadLettered(limit: number): Promise<readonly OutboxRecord[]>;
  /** Clears the DLQ state and attempt counter so the relay picks the record up again. */
  replay(id: string, at: Date): Promise<void>;
}

export interface InboxStore<Tx> {
  /**
   * INSERT (consumer, message_id) inside `tx`. Resolves true when newly
   * recorded, false when the pair already exists (duplicate delivery).
   */
  tryRecord(tx: Tx, consumer: string, messageId: string, at: Date): Promise<boolean>;
}
