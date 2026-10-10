import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeBackoffMs } from './backoff.js';
import { InvalidInboxMessageError, InvalidOutboxRecordError, InvalidReplayError, PermanentPublishError } from './errors.js';
import { InboxConsumer } from './inbox.js';
import { MemoryBroker, MemoryDatabase } from './memory.js';
import { createOutboxRecord, type NewOutboxEvent } from './record.js';
import { OutboxRelay } from './relay.js';
import { FakeClock, seededRandom, uuid } from './test-helpers.js';

const T0 = Date.UTC(2026, 0, 1);
const CFG = { batchSize: 50, maxAttempts: 3, backoff: { baseMs: 1000, capMs: 60_000 } };

function evt(aggregate: number, type = 'order_group.paid', payload = {}): NewOutboxEvent {
  return { aggregateType: 'order_group', aggregateId: uuid(aggregate), eventType: type, payload };
}

async function emit(db: MemoryDatabase, clock: FakeClock, id: number, e: NewOutboxEvent): Promise<void> {
  await db.run(async (tx) => {
    await db.append(tx, createOutboxRecord(e, { id: uuid(id), now: clock.now() }));
  });
}

function setup() {
  const db = new MemoryDatabase();
  const clock = new FakeClock(T0);
  const broker = new MemoryBroker();
  const relay = new OutboxRelay(
    { store: db, publisher: broker, clock, random: seededRandom(7) },
    CFG,
  );
  const consumer = new InboxConsumer({ uow: db, inbox: db, clock });
  return { db, clock, broker, relay, consumer };
}

describe('record validation', () => {
  const ctx = { id: uuid(1), now: new Date(T0) };
  it('rejects bigint payloads (money must be serialised as string)', () => {
    expect(() => createOutboxRecord(evt(1, 'order_group.paid', { total: 10n }), ctx)).toThrow(InvalidOutboxRecordError);
  });
  it('rejects bad event types and ids', () => {
    expect(() => createOutboxRecord(evt(1, 'Paid'), ctx)).toThrow(InvalidOutboxRecordError);
    expect(() => createOutboxRecord(evt(1), { ...ctx, id: 'x' })).toThrow(InvalidOutboxRecordError);
  });
  it('defaults the ordering key to the aggregate', () => {
    expect(createOutboxRecord(evt(5), ctx).orderingKey).toBe(`order_group:${uuid(5)}`);
  });
});

describe('transactional outbox', () => {
  it('rolls the event back together with the state change', async () => {
    const { db, clock } = setup();
    await expect(
      db.run(async (tx) => {
        tx.set('order:1', 'paid');
        await db.append(tx, createOutboxRecord(evt(1), { id: uuid(1), now: clock.now() }));
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(db.allOutbox()).toHaveLength(0);
    expect(db.readKv('order:1')).toBeUndefined();
  });

  it('publishes and marks published', async () => {
    const { db, clock, broker, relay } = setup();
    await emit(db, clock, 1, evt(1));
    const r = await relay.runOnce();
    expect(r.published).toBe(1);
    expect(broker.publishedLog).toHaveLength(1);
    expect(db.allOutbox()[0]?.publishedAt).not.toBeNull();
    expect((await relay.runOnce()).published).toBe(0);
  });
});

describe('at-least-once: crash between publish and mark published', () => {
  it('republishes, and the inbox turns the repeat into one side effect', async () => {
    const { db, clock, broker, relay, consumer } = setup();
    await emit(db, clock, 1, evt(1));
    const original = db.markPublished.bind(db);
    let crashed = false;
    db.markPublished = (id, at) => {
      if (!crashed) {
        crashed = true;
        return Promise.reject(new Error('relay crashed before mark'));
      }
      return original(id, at);
    };
    await expect(relay.runOnce()).rejects.toThrow('relay crashed');
    await relay.runOnce();
    expect(broker.publishedLog).toHaveLength(2); // published twice: at-least-once, not exactly-once
    const handle = (m: { messageId: string }) =>
      consumer.consume({
        consumer: 'ledger',
        messageId: m.messageId,
        handler: async (tx) => {
          const n = tx.get('postings');
          tx.set('postings', typeof n === 'number' ? n + 1 : 1);
        },
      }).then(() => undefined);
    await broker.drain(handle);
    expect(db.readKv('postings')).toBe(1);
  });
});

describe('inbox', () => {
  it('duplicate delivery produces one side effect', async () => {
    const { db, clock, broker, relay, consumer } = setup();
    await emit(db, clock, 1, evt(1));
    await relay.runOnce();
    broker.duplicateAll();
    broker.duplicateAll();
    let effects = 0;
    const out: string[] = [];
    await broker.drain(async (m) => {
      const o = await consumer.consume({
        consumer: 'notifications',
        messageId: m.messageId,
        handler: async (tx) => {
          effects += 1;
          tx.set('sent', true);
        },
      });
      out.push(o);
    });
    expect(effects).toBe(1);
    expect(out.filter((o) => o === 'processed')).toHaveLength(1);
    expect(out.filter((o) => o === 'duplicate')).toHaveLength(3);
  });

  it('crash between side effect and ack: redelivery is a no-op', async () => {
    const { db, clock, broker, relay, consumer } = setup();
    await emit(db, clock, 1, evt(1));
    await relay.runOnce();
    let crash = true;
    let effects = 0;
    const handle = async (m: { messageId: string }): Promise<void> => {
      await consumer.consume({
        consumer: 'ledger',
        messageId: m.messageId,
        handler: async (tx) => {
          effects += 1;
          tx.set('posted', true);
        },
      });
      if (crash) {
        crash = false;
        throw new Error('process died before broker ack');
      }
    };
    expect(await broker.drain(handle)).toEqual({ acked: 0, unacked: 1 });
    expect(await broker.drain(handle)).toEqual({ acked: 1, unacked: 0 });
    expect(effects).toBe(1);
  });

  it('handler failure rolls back the inbox row so a retry runs the handler', async () => {
    const { db, consumer } = setup();
    const args = { consumer: 'c', messageId: uuid(9) };
    await expect(
      consumer.consume({ ...args, handler: async (tx) => { tx.set('x', 1); throw new Error('fail'); } }),
    ).rejects.toThrow('fail');
    expect(db.inboxSize()).toBe(0);
    expect(db.readKv('x')).toBeUndefined();
    expect(await consumer.consume({ ...args, handler: async (tx) => { tx.set('x', 2); } })).toBe('processed');
    expect(db.readKv('x')).toBe(2);
  });

  it('dedupes per consumer, not globally', async () => {
    const { db, consumer } = setup();
    const h = async (): Promise<void> => undefined;
    expect(await consumer.consume({ consumer: 'a', messageId: uuid(1), handler: h })).toBe('processed');
    expect(await consumer.consume({ consumer: 'b', messageId: uuid(1), handler: h })).toBe('processed');
    expect(db.inboxSize()).toBe(2);
  });

  it('rejects malformed message ids', async () => {
    const { consumer } = setup();
    await expect(consumer.consume({ consumer: 'a', messageId: 'nope', handler: async () => undefined })).rejects.toThrow(
      InvalidInboxMessageError,
    );
  });
});

describe('ordering per aggregate', () => {
  it('relays events of one aggregate in occurrence order', async () => {
    const { db, clock, broker, relay } = setup();
    for (let i = 1; i <= 5; i += 1) {
      await emit(db, clock, i, evt(1, `order_group.step_${i}`));
      clock.advance(1);
    }
    await relay.runOnce();
    expect(broker.publishedLog.map((m) => m.eventType)).toEqual([1, 2, 3, 4, 5].map((i) => `order_group.step_${i}`));
  });

  it('a failing head blocks later events of the same aggregate but not other aggregates', async () => {
    const { db, clock, broker, relay } = setup();
    await emit(db, clock, 1, evt(1, 'order_group.placed'));
    clock.advance(1);
    await emit(db, clock, 2, evt(1, 'order_group.paid'));
    clock.advance(1);
    await emit(db, clock, 3, evt(2, 'order_group.placed'));
    broker.failWith = () => null;
    const realPublish = broker.publish.bind(broker);
    broker.publish = (m) =>
      m.messageId === uuid(1) ? Promise.reject(new Error('broker down')) : realPublish(m);
    const r = await relay.runOnce();
    expect(r).toMatchObject({ published: 1, retryScheduled: 1, skippedForOrdering: 1 });
    expect(broker.publishedLog.map((m) => m.messageId)).toEqual([uuid(3)]);
    // Head is not due yet: the later event of aggregate 1 must still be withheld.
    expect((await relay.runOnce()).published).toBe(0);
    broker.publish = realPublish;
    clock.advance(60_000);
    await relay.runOnce();
    expect(broker.publishedLog.map((m) => m.messageId)).toEqual([uuid(3), uuid(1), uuid(2)]);
  });

  it('property: any interleaving of aggregates keeps per-aggregate order', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 1, maxLength: 30 }), async (aggs) => {
        const { db, clock, broker, relay } = setup();
        for (const [i, a] of aggs.entries()) {
          await emit(db, clock, i + 1, { ...evt(a), payload: { seq: i } });
          clock.advance(1);
        }
        await relay.runOnce();
        const seen = new Map<string, number>();
        for (const m of broker.publishedLog) {
          const seq = (m.payload as { seq: number }).seq;
          expect(seq).toBeGreaterThan(seen.get(m.aggregateId) ?? -1);
          seen.set(m.aggregateId, seq);
        }
        expect(broker.publishedLog).toHaveLength(aggs.length);
      }),
      { numRuns: 50 },
    );
  });
});

describe('retry and DLQ', () => {
  it('retries with backoff then dead-letters at max attempts', async () => {
    const { db, clock, broker, relay } = setup();
    await emit(db, clock, 1, evt(1));
    broker.failWith = () => new Error('503');
    expect((await relay.runOnce()).retryScheduled).toBe(1);
    expect((await relay.runOnce()).published).toBe(0); // not due: backoff respected
    clock.advance(60_000);
    expect((await relay.runOnce()).retryScheduled).toBe(1);
    clock.advance(60_000);
    expect((await relay.runOnce()).deadLettered).toBe(1);
    const rec = db.allOutbox()[0];
    expect(rec?.publishAttempts).toBe(3);
    expect(rec?.deadLetteredAt).not.toBeNull();
    expect(rec?.lastError).toContain('503');
    clock.advance(10 ** 9);
    expect((await relay.runOnce()).published).toBe(0); // DLQ'd records are not retried automatically
  });

  it('replay returns a dead-lettered record to the queue with a fresh budget', async () => {
    const { db, clock, broker, relay } = setup();
    await emit(db, clock, 1, evt(1));
    broker.failWith = () => new PermanentPublishError('schema rejected');
    expect((await relay.runOnce()).deadLettered).toBe(1);
    expect(db.allOutbox()[0]?.publishAttempts).toBe(1); // permanent: no budget burned
    broker.failWith = null;
    await relay.replay(uuid(1));
    expect(db.allOutbox()[0]?.publishAttempts).toBe(0);
    expect((await relay.runOnce()).published).toBe(1);
    await expect(relay.replay(uuid(1))).rejects.toThrow(InvalidReplayError);
  });

  it('a dead-lettered head blocks its aggregate until replay, then order is preserved', async () => {
    const { db, clock, broker, relay } = setup();
    await emit(db, clock, 1, evt(1, 'order_group.placed'));
    clock.advance(1);
    await emit(db, clock, 2, evt(1, 'order_group.paid'));
    broker.failWith = () => new PermanentPublishError('bad');
    await relay.runOnce();
    broker.failWith = null;
    expect((await relay.runOnce()).published).toBe(0);
    expect(await relay.replayAll()).toBe(1);
    await relay.runOnce();
    expect(broker.publishedLog.map((m) => m.eventType)).toEqual(['order_group.placed', 'order_group.paid']);
  });
});

describe('backoff', () => {
  const cfg = { baseMs: 1000, capMs: 60_000 };
  it('property: bounded by [ceiling/2, ceiling] and never above cap', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 200 }), fc.double({ min: 0, max: 0.999999, noNaN: true }), (attempt, r) => {
        const d = computeBackoffMs(attempt, cfg, () => r);
        const ceiling = Math.min(cfg.capMs, cfg.baseMs * 2 ** Math.min(attempt - 1, 52));
        expect(d).toBeGreaterThanOrEqual(Math.floor(ceiling / 2));
        expect(d).toBeLessThanOrEqual(ceiling);
      }),
    );
  });
  it('grows exponentially before the cap', () => {
    expect(computeBackoffMs(1, cfg, () => 0)).toBe(500);
    expect(computeBackoffMs(2, cfg, () => 0)).toBe(1000);
    expect(computeBackoffMs(3, cfg, () => 0)).toBe(2000);
    expect(computeBackoffMs(20, cfg, () => 0)).toBe(30_000);
  });
  it('rejects an out-of-range random source', () => {
    expect(() => computeBackoffMs(1, cfg, () => 1)).toThrow();
  });
});
