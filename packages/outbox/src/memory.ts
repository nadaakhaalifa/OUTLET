/**
 * In-memory adapters. DEVELOPMENT AND TEST FIXTURES ONLY: they hold no real
 * data and provide no durability. Transaction semantics are emulated with a
 * snapshot taken at the start of `run` and restored on throw, with runs
 * serialised. This models atomic commit/rollback; it does NOT model
 * concurrent-writer behaviour (SKIP LOCKED, isolation anomalies), which must
 * be tested against Postgres.
 */
import { DuplicateOutboxEventError, InvalidReplayError, UnknownOutboxEventError } from './errors.js';
import type {
  DeadLetterUpdate,
  FailureUpdate,
  InboxStore,
  OutboxMessage,
  OutboxStore,
  Publisher,
  UnitOfWork,
} from './ports.js';
import type { JsonValue, OutboxRecord } from './record.js';

export interface MemoryTx {
  readonly kind: 'memory-tx';
  /** Scratch key/value space standing in for the consumer's business tables. */
  get(key: string): JsonValue | undefined;
  set(key: string, value: JsonValue): void;
}

interface Snapshot {
  readonly outbox: Map<string, OutboxRecord>;
  readonly inbox: Map<string, Date>;
  readonly kv: Map<string, JsonValue>;
}

export class MemoryDatabase implements UnitOfWork<MemoryTx>, OutboxStore<MemoryTx>, InboxStore<MemoryTx> {
  private outbox = new Map<string, OutboxRecord>();
  private inbox = new Map<string, Date>();
  private kv = new Map<string, JsonValue>();
  private queue: Promise<unknown> = Promise.resolve();

  // ---- UnitOfWork ----
  run<T>(fn: (tx: MemoryTx) => Promise<T>): Promise<T> {
    const exec = async (): Promise<T> => {
      const snap: Snapshot = {
        outbox: new Map(this.outbox),
        inbox: new Map(this.inbox),
        kv: new Map(this.kv),
      };
      const tx: MemoryTx = {
        kind: 'memory-tx',
        get: (k) => this.kv.get(k),
        set: (k, v) => {
          this.kv.set(k, v);
        },
      };
      try {
        return await fn(tx);
      } catch (e) {
        this.outbox = snap.outbox;
        this.inbox = snap.inbox;
        this.kv = snap.kv;
        throw e;
      }
    };
    const result = this.queue.then(exec, exec);
    this.queue = result.catch(() => undefined);
    return result;
  }

  // ---- OutboxStore ----
  append(_tx: MemoryTx, record: OutboxRecord): Promise<void> {
    if (this.outbox.has(record.id)) {
      return Promise.reject(new DuplicateOutboxEventError(`outbox event ${record.id} already exists`));
    }
    this.outbox.set(record.id, record);
    return Promise.resolve();
  }

  claimDue(now: Date, limit: number): Promise<readonly OutboxRecord[]> {
    const sorted = [...this.outbox.values()]
      .filter((r) => r.publishedAt === null)
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || (a.id < b.id ? -1 : 1));
    // Include published rows' keys? Published rows never block: only unpublished ones are iterated.
    const blocked = new Set<string>();
    const out: OutboxRecord[] = [];
    for (const r of sorted) {
      const key = r.orderingKey;
      if (key !== null && blocked.has(key)) continue;
      const dead = r.deadLetteredAt !== null;
      const notDue = r.nextAttemptAt !== null && r.nextAttemptAt.getTime() > now.getTime();
      if (dead || notDue) {
        if (key !== null) blocked.add(key);
        continue;
      }
      if (out.length < limit) out.push(r);
    }
    return Promise.resolve(out);
  }

  private update(id: string, patch: Partial<Mutable<OutboxRecord>>): void {
    const cur = this.outbox.get(id);
    if (cur === undefined) throw new UnknownOutboxEventError(`unknown outbox event ${id}`);
    this.outbox.set(id, { ...cur, ...patch });
  }

  markPublished(id: string, at: Date): Promise<void> {
    this.update(id, { publishedAt: at, nextAttemptAt: null, lastError: null });
    return Promise.resolve();
  }

  recordFailure(id: string, u: FailureUpdate): Promise<void> {
    this.update(id, { publishAttempts: u.attempts, lastError: u.error, nextAttemptAt: u.nextAttemptAt });
    return Promise.resolve();
  }

  deadLetter(id: string, u: DeadLetterUpdate): Promise<void> {
    this.update(id, { publishAttempts: u.attempts, lastError: u.error, deadLetteredAt: u.at });
    return Promise.resolve();
  }

  listDeadLettered(limit: number): Promise<readonly OutboxRecord[]> {
    const dead = [...this.outbox.values()]
      .filter((r) => r.deadLetteredAt !== null && r.publishedAt === null)
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || (a.id < b.id ? -1 : 1));
    return Promise.resolve(dead.slice(0, limit));
  }

  replay(id: string, _at: Date): Promise<void> {
    const cur = this.outbox.get(id);
    if (cur === undefined) return Promise.reject(new UnknownOutboxEventError(`unknown outbox event ${id}`));
    if (cur.deadLetteredAt === null || cur.publishedAt !== null) {
      return Promise.reject(new InvalidReplayError(`outbox event ${id} is not dead-lettered`));
    }
    this.update(id, { deadLetteredAt: null, publishAttempts: 0, nextAttemptAt: null });
    return Promise.resolve();
  }

  // ---- InboxStore ----
  tryRecord(_tx: MemoryTx, consumer: string, messageId: string, at: Date): Promise<boolean> {
    const key = `${consumer}\u0000${messageId}`;
    if (this.inbox.has(key)) return Promise.resolve(false);
    this.inbox.set(key, at);
    return Promise.resolve(true);
  }

  // ---- inspection helpers for tests ----
  allOutbox(): readonly OutboxRecord[] {
    return [...this.outbox.values()];
  }
  inboxSize(): number {
    return this.inbox.size;
  }
  readKv(key: string): JsonValue | undefined {
    return this.kv.get(key);
  }
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * In-memory broker with explicit ack. `drain` hands each message to the
 * handler; a rejection means "no ack", so the message is redelivered. This is
 * how crash-before-ack and duplicate delivery are simulated.
 */
export class MemoryBroker implements Publisher {
  private pending: OutboxMessage[] = [];
  readonly publishedLog: OutboxMessage[] = [];
  /** When set, publish rejects while it returns an Error (broker outage simulation). */
  failWith: (() => Error | null) | null = null;

  publish(message: OutboxMessage): Promise<void> {
    const err = this.failWith?.() ?? null;
    if (err !== null) return Promise.reject(err);
    this.pending.push(message);
    this.publishedLog.push(message);
    return Promise.resolve();
  }

  /** Re-enqueue a message a second time, as a broker may on redelivery. */
  duplicateAll(): void {
    this.pending = this.pending.flatMap((m) => [m, m]);
  }

  /** Deliver in queue order; unacked (throwing) messages are requeued once per drain pass. */
  async drain(handler: (m: OutboxMessage) => Promise<void>): Promise<{ acked: number; unacked: number }> {
    const batch = this.pending;
    this.pending = [];
    let acked = 0;
    let unacked = 0;
    const requeue: OutboxMessage[] = [];
    for (const m of batch) {
      try {
        await handler(m);
        acked += 1;
      } catch {
        unacked += 1;
        requeue.push(m);
      }
    }
    this.pending = [...requeue, ...this.pending];
    return { acked, unacked };
  }
}
