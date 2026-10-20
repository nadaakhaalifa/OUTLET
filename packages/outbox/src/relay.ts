import { assertBackoffConfig, computeBackoffMs, type BackoffConfig } from './backoff.js';
import { InvalidConfigError, PermanentPublishError } from './errors.js';
import type { Clock, OutboxMessage, OutboxStore, Publisher, Random } from './ports.js';
import type { OutboxRecord } from './record.js';

export interface RelayConfig {
  readonly batchSize: number;
  /** Total publish attempts before a record is dead-lettered (>= 1). */
  readonly maxAttempts: number;
  readonly backoff: BackoffConfig;
}

export interface RelayReport {
  readonly published: number;
  readonly retryScheduled: number;
  readonly deadLettered: number;
  /** Held back this run because an earlier event of the same ordering key failed. */
  readonly skippedForOrdering: number;
}

const MAX_ERROR_LENGTH = 500;

export function toMessage(r: OutboxRecord): OutboxMessage {
  return {
    messageId: r.id,
    occurredAt: r.occurredAt,
    aggregateType: r.aggregateType,
    aggregateId: r.aggregateId,
    eventType: r.eventType,
    eventVersion: r.eventVersion,
    orderingKey: r.orderingKey,
    payload: r.payload,
    headers: r.headers,
  };
}

/** Only the error class and a truncated message are kept; never include payloads in errors. */
function describeError(e: unknown): string {
  const text = e instanceof Error ? `${e.name}: ${e.message}` : 'non-error thrown';
  return text.length > MAX_ERROR_LENGTH ? text.slice(0, MAX_ERROR_LENGTH) : text;
}

/**
 * Polls the outbox, publishes, and marks records published. Delivery is
 * at-least-once: if the process dies after `publish` but before
 * `markPublished`, the record is published again. Consumers must dedupe via
 * the inbox. This is deliberately not an exactly-once mechanism.
 */
export class OutboxRelay<Tx> {
  private readonly config: RelayConfig;

  constructor(
    private readonly deps: {
      readonly store: OutboxStore<Tx>;
      readonly publisher: Publisher;
      readonly clock: Clock;
      readonly random: Random;
    },
    config: RelayConfig,
  ) {
    if (!Number.isInteger(config.batchSize) || config.batchSize < 1) {
      throw new InvalidConfigError('batchSize must be an integer >= 1');
    }
    if (!Number.isInteger(config.maxAttempts) || config.maxAttempts < 1) {
      throw new InvalidConfigError('maxAttempts must be an integer >= 1');
    }
    assertBackoffConfig(config.backoff);
    this.config = config;
  }

  async runOnce(): Promise<RelayReport> {
    const { store, publisher, clock, random } = this.deps;
    const records = await store.claimDue(clock.now(), this.config.batchSize);
    const blocked = new Set<string>();
    let published = 0;
    let retryScheduled = 0;
    let deadLettered = 0;
    let skippedForOrdering = 0;

    for (const record of records) {
      const key = record.orderingKey;
      if (key !== null && blocked.has(key)) {
        skippedForOrdering += 1;
        continue;
      }
      let failure: unknown = null;
      let failed = false;
      try {
        await publisher.publish(toMessage(record));
      } catch (e) {
        failed = true;
        failure = e;
      }
      if (!failed) {
        // If this throws, the record stays unpublished and is published again:
        // that is the at-least-once window, by design.
        await store.markPublished(record.id, clock.now());
        published += 1;
        continue;
      }
      const attempts = record.publishAttempts + 1;
      const error = describeError(failure);
      if (key !== null) blocked.add(key);
      if (failure instanceof PermanentPublishError || attempts >= this.config.maxAttempts) {
        await store.deadLetter(record.id, { error, attempts, at: clock.now() });
        deadLettered += 1;
      } else {
        const delay = computeBackoffMs(attempts, this.config.backoff, random);
        await store.recordFailure(record.id, {
          error,
          attempts,
          nextAttemptAt: new Date(clock.now().getTime() + delay),
        });
        retryScheduled += 1;
      }
    }
    return { published, retryScheduled, deadLettered, skippedForOrdering };
  }

  /** Operator action: move one dead-lettered record back into the queue. */
  async replay(id: string): Promise<void> {
    await this.deps.store.replay(id, this.deps.clock.now());
  }

  /** Operator action: replay every dead-lettered record, oldest first. Returns the count. */
  async replayAll(limit = 1000): Promise<number> {
    const dead = await this.deps.store.listDeadLettered(limit);
    for (const r of dead) await this.deps.store.replay(r.id, this.deps.clock.now());
    return dead.length;
  }
}
