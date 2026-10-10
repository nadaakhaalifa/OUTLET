import { describe, expect, it } from 'vitest';
import { assertBackoffConfig, computeBackoffMs } from './backoff.js';
import {
  DuplicateOutboxEventError,
  InvalidConfigError,
  InvalidInboxMessageError,
  InvalidOutboxRecordError,
  InvalidReplayError,
  InvalidSagaDefinitionError,
  InvalidSagaTransitionError,
  PermanentPublishError,
  UnknownOutboxEventError,
} from './errors.js';
import { InboxConsumer } from './inbox.js';
import { MemoryBroker, MemoryDatabase } from './memory.js';
import { createOutboxRecord, isUuid, type NewOutboxEvent, type OutboxRecord } from './record.js';
import { OutboxRelay, toMessage } from './relay.js';
import {
  applyEvent,
  defineSaga,
  nextCommand,
  startSaga,
  type SagaDefinition,
  type SagaState,
  type SagaStep,
} from './saga.js';
import { FakeClock, uuid } from './test-helpers.js';

const T0 = Date.UTC(2026, 0, 1);
const CFG = { batchSize: 50, maxAttempts: 3, backoff: { baseMs: 1000, capMs: 60_000 } };

// ---------------------------------------------------------------- backoff
describe('backoff exact values and validation', () => {
  const cfg = { baseMs: 1000, capMs: 60_000 };
  it('computes equal-jitter delays', () => {
    expect(computeBackoffMs(1, cfg, () => 0)).toBe(500);
    expect(computeBackoffMs(1, cfg, () => 0.5)).toBe(750);
    expect(computeBackoffMs(1, cfg, () => 0.999999)).toBe(1000);
    expect(computeBackoffMs(3, cfg, () => 0)).toBe(2000);
    expect(computeBackoffMs(3, cfg, () => 0.5)).toBe(3000);
    expect(computeBackoffMs(10, cfg, () => 0)).toBe(30_000);
    expect(computeBackoffMs(10, cfg, () => 0.999999)).toBe(60_000);
    expect(computeBackoffMs(1, { baseMs: 3, capMs: 3 }, () => 0.999)).toBe(3);
    expect(computeBackoffMs(1, { baseMs: 1, capMs: 1 }, () => 0)).toBe(0 + 0);
  });
  it('caps the exponent at 52', () => {
    const big = { baseMs: 1, capMs: Number.MAX_SAFE_INTEGER };
    expect(computeBackoffMs(53, big, () => 0)).toBe(2 ** 51);
    expect(computeBackoffMs(500, big, () => 0)).toBe(2 ** 51);
  });
  it('validates config with messages and exact boundaries', () => {
    expect(() => assertBackoffConfig({ baseMs: 0, capMs: 5 })).toThrow('baseMs must be an integer >= 1');
    expect(() => assertBackoffConfig({ baseMs: 1.5, capMs: 5 })).toThrow(InvalidConfigError);
    expect(() => assertBackoffConfig({ baseMs: 1, capMs: 1 })).not.toThrow();
    expect(() => assertBackoffConfig({ baseMs: 5, capMs: 4 })).toThrow('capMs must be >= baseMs');
    expect(() => assertBackoffConfig({ baseMs: 5, capMs: 10.5 })).toThrow('capMs must be >= baseMs');
    expect(() => assertBackoffConfig({ baseMs: 5, capMs: 5 })).not.toThrow();
    expect(() => assertBackoffConfig({ baseMs: 5, capMs: 5 })).not.toThrow();
  });
  it('computeBackoffMs validates its inputs', () => {
    expect(() => computeBackoffMs(1, { baseMs: 0, capMs: 5 }, () => 0)).toThrow('baseMs must be an integer >= 1');
    expect(() => computeBackoffMs(0, cfg, () => 0)).toThrow('attempt must be an integer >= 1');
    expect(() => computeBackoffMs(1.5, cfg, () => 0)).toThrow('attempt must be an integer >= 1');
    expect(() => computeBackoffMs(1, cfg, () => 1)).toThrow('random must return a value in [0, 1)');
    expect(() => computeBackoffMs(1, cfg, () => -0.1)).toThrow('random must return a value in [0, 1)');
    expect(() => computeBackoffMs(1, cfg, () => NaN)).toThrow(InvalidConfigError);
    expect(() => computeBackoffMs(1, cfg, () => 0)).not.toThrow();
  });
});

// ---------------------------------------------------------------- record
describe('createOutboxRecord exact validation', () => {
  const ctx = { id: uuid(1), now: new Date(T0) };
  const base: NewOutboxEvent = {
    aggregateType: 'order_group',
    aggregateId: uuid(2),
    eventType: 'order_group.paid',
    payload: {},
  };
  const make = (over: Partial<NewOutboxEvent> = {}, c = ctx) => createOutboxRecord({ ...base, ...over }, c);

  it('builds the exact unpublished record with defaults', () => {
    expect(make()).toEqual({
      id: uuid(1),
      occurredAt: new Date(T0),
      aggregateType: 'order_group',
      aggregateId: uuid(2),
      eventType: 'order_group.paid',
      eventVersion: 1,
      orderingKey: `order_group:${uuid(2)}`,
      payload: {},
      headers: {},
      publishedAt: null,
      publishAttempts: 0,
      lastError: null,
      nextAttemptAt: null,
      deadLetteredAt: null,
    });
  });
  it('keeps explicit version, ordering key, headers', () => {
    const r = make({ eventVersion: 2, orderingKey: 'k', headers: { h: 'v' } });
    expect(r.eventVersion).toBe(2);
    expect(r.orderingKey).toBe('k');
    expect(r.headers).toEqual({ h: 'v' });
    expect(make({ orderingKey: null }).orderingKey).toBeNull();
  });
  it('rejects with the documented messages', () => {
    expect(() => make({}, { ...ctx, id: 'nope' })).toThrow('id must be a lowercase uuid');
    expect(() => make({ aggregateType: '' })).toThrow('aggregateType is empty');
    expect(() => make({ aggregateId: 'x' })).toThrow('aggregateId must be a lowercase uuid');
    expect(() => make({ eventType: 'paid' })).toThrow('eventType must look like "order_group.paid"');
    expect(() => make({ eventVersion: 0 })).toThrow('eventVersion must be an integer >= 1');
    expect(() => make({ eventVersion: 1.5 })).toThrow('eventVersion must be an integer >= 1');
    expect(() => make({}, { ...ctx, now: new Date(NaN) })).toThrow('invalid timestamp');
    expect(() => make({ orderingKey: '' })).toThrow('orderingKey must be null or non-empty');
  });
  it('anchors the uuid and event type patterns', () => {
    expect(isUuid(uuid(1))).toBe(true);
    expect(isUuid(`${uuid(1)}x`)).toBe(false);
    expect(isUuid(`x${uuid(1)}`)).toBe(false);
    expect(isUuid(uuid(10).toUpperCase())).toBe(false);
    expect(() => make({ eventType: 'Order.paid' })).toThrow(InvalidOutboxRecordError);
    expect(() => make({ eventType: 'order.paid!' })).toThrow(InvalidOutboxRecordError);
    expect(() => make({ eventType: 'order.' })).toThrow(InvalidOutboxRecordError);
    expect(() => make({ eventType: 'a.b.c' })).not.toThrow();
    expect(() => make({ eventType: 'order_group.paid_2' })).not.toThrow();
  });
  it('payload validation reports the path', () => {
    expect(() => make({ payload: { a: NaN } })).toThrow('payload.a: non-finite number');
    expect(() => make({ payload: { a: Infinity } })).toThrow('payload.a: non-finite number');
    expect(() => make({ payload: { a: [1, { b: NaN }] } })).toThrow('payload.a[1].b: non-finite number');
    expect(() => make({ payload: { n: { m: 1n as never } } })).toThrow(
      'payload.n.m: bigint is not JSON; serialise money minor units as a string',
    );
    expect(() => make({ payload: { d: new Date(0) as never } })).toThrow('payload.d: value is not JSON-serialisable');
    expect(() => make({ payload: { u: undefined as never } })).toThrow('payload.u: value is not JSON-serialisable');
    expect(() => make({ payload: { f: (() => 1) as never } })).toThrow('payload.f: value is not JSON-serialisable');
    expect(() => make({ headers: { h: NaN } })).toThrow('headers.h: non-finite number');
  });
  it('accepts every JSON shape', () => {
    expect(() =>
      make({ payload: { s: 'x', b: false, t: true, n: null, i: 3, f: -1.5, a: [1, 'a', null, [true]], o: { p: { q: 0 } } } }),
    ).not.toThrow();
    expect(() => make({ payload: { a: [new Date(0) as never] } })).toThrow('payload.a[0]: value is not JSON-serialisable');
  });
});

// ---------------------------------------------------------------- inbox
describe('InboxConsumer validation', () => {
  it('rejects an empty consumer or non-uuid message id without running the handler', async () => {
    const db = new MemoryDatabase();
    const c = new InboxConsumer({ uow: db, inbox: db, clock: new FakeClock(T0) });
    let ran = 0;
    const handler = (): Promise<void> => {
      ran += 1;
      return Promise.resolve();
    };
    await expect(c.consume({ consumer: '', messageId: uuid(1), handler })).rejects.toThrow('consumer name is empty');
    await expect(c.consume({ consumer: 'x', messageId: 'bad', handler })).rejects.toThrow(
      'messageId must be a lowercase uuid',
    );
    await expect(c.consume({ consumer: 'x', messageId: 'bad', handler })).rejects.toThrow(InvalidInboxMessageError);
    expect(ran).toBe(0);
    expect(db.inboxSize()).toBe(0);
    await expect(c.consume({ consumer: 'x', messageId: uuid(1), handler })).resolves.toBe('processed');
    await expect(c.consume({ consumer: 'x', messageId: uuid(1), handler })).resolves.toBe('duplicate');
    await expect(c.consume({ consumer: 'y', messageId: uuid(1), handler })).resolves.toBe('processed');
    expect(ran).toBe(2);
  });
});

// ---------------------------------------------------------------- memory
describe('MemoryDatabase exact behaviour', () => {
  const rec = (n: number, over: Partial<NewOutboxEvent> = {}, at = T0): OutboxRecord =>
    createOutboxRecord(
      { aggregateType: 'order_group', aggregateId: uuid(100 + n), eventType: 'order_group.paid', payload: {}, ...over },
      { id: uuid(n), now: new Date(at) },
    );
  async function seed(db: MemoryDatabase, ...rs: OutboxRecord[]): Promise<void> {
    await db.run(async (tx) => {
      for (const r of rs) await db.append(tx, r);
    });
  }

  it('tx exposes kind and a working get/set', async () => {
    const db = new MemoryDatabase();
    await db.run((tx) => {
      expect(tx.kind).toBe('memory-tx');
      expect(tx.get('a')).toBeUndefined();
      tx.set('a', 5);
      expect(tx.get('a')).toBe(5);
      return Promise.resolve();
    });
    expect(db.readKv('a')).toBe(5);
  });
  it('rolls back inbox and kv writes on throw', async () => {
    const db = new MemoryDatabase();
    await expect(
      db.run(async (tx) => {
        tx.set('k', 1);
        await db.tryRecord(tx, 'c', uuid(1), new Date(T0));
        throw new Error('x');
      }),
    ).rejects.toThrow('x');
    expect(db.readKv('k')).toBeUndefined();
    expect(db.inboxSize()).toBe(0);
  });
  it('rejects duplicates without overwriting', async () => {
    const db = new MemoryDatabase();
    await seed(db, rec(1, { payload: { v: 1 } }));
    await expect(seed(db, rec(1, { payload: { v: 2 } }))).rejects.toThrow(DuplicateOutboxEventError);
    await expect(seed(db, rec(1, { payload: { v: 2 } }))).rejects.toThrow(`outbox event ${uuid(1)} already exists`);
    expect(db.allOutbox()).toHaveLength(1);
    expect(db.allOutbox()[0]?.payload).toEqual({ v: 1 });
  });
  it('claimDue orders by time then id, honours limit and due boundary', async () => {
    const db = new MemoryDatabase();
    await seed(db, rec(3, {}, T0 + 10), rec(2, {}, T0), rec(1, {}, T0), rec(4, {}, T0 + 20));
    const all = await db.claimDue(new Date(T0 + 100), 10);
    expect(all.map((r) => r.id)).toEqual([uuid(1), uuid(2), uuid(3), uuid(4)]);
    expect((await db.claimDue(new Date(T0 + 100), 2)).map((r) => r.id)).toEqual([uuid(1), uuid(2)]);
    expect(await db.claimDue(new Date(T0 + 100), 0)).toEqual([]);
    // sorting by id when occurredAt ties, and by time when ids invert
    const db2 = new MemoryDatabase();
    await seed(db2, rec(9, {}, T0), rec(5, {}, T0 + 1), rec(7, {}, T0));
    expect((await db2.claimDue(new Date(T0 + 5), 10)).map((r) => r.id)).toEqual([uuid(7), uuid(9), uuid(5)]);
  });
  it('ties on occurredAt are broken by id for claimDue and listDeadLettered', async () => {
    const db = new MemoryDatabase();
    await seed(db, rec(8), rec(9), rec(7), rec(6));
    expect((await db.claimDue(new Date(T0), 10)).map((x) => x.id)).toEqual([uuid(6), uuid(7), uuid(8), uuid(9)]);
    for (const n of [8, 9, 7, 6]) await db.deadLetter(uuid(n), { error: 'e', attempts: 3, at: new Date(T0) });
    expect((await db.listDeadLettered(10)).map((x) => x.id)).toEqual([uuid(6), uuid(7), uuid(8), uuid(9)]);
    const db2 = new MemoryDatabase();
    await seed(db2, rec(6), rec(9), rec(7), rec(8));
    expect((await db2.claimDue(new Date(T0), 10)).map((x) => x.id)).toEqual([uuid(6), uuid(7), uuid(8), uuid(9)]);
  });
  it('claimDue excludes published, treats nextAttemptAt == now as due, and blocks per ordering key', async () => {
    const db = new MemoryDatabase();
    const now = new Date(T0 + 1000);
    await seed(
      db,
      rec(1, { orderingKey: 'a' }, T0),
      rec(2, { orderingKey: 'a' }, T0 + 1),
      rec(3, { orderingKey: 'b' }, T0 + 2),
      rec(4, { orderingKey: null }, T0 + 3),
      rec(5, { orderingKey: null }, T0 + 4),
      rec(6, { orderingKey: 'c' }, T0 + 5),
      rec(7, { orderingKey: 'c' }, T0 + 6),
    );
    await db.markPublished(uuid(6), now);
    // 1 is not yet due -> 2 (same key) is withheld
    await db.recordFailure(uuid(1), { error: 'e', attempts: 1, nextAttemptAt: new Date(T0 + 1001) });
    // null-key record dead-lettered must not block the other null-key record
    await db.deadLetter(uuid(4), { error: 'e', attempts: 3, at: now });
    expect((await db.claimDue(now, 10)).map((r) => r.id)).toEqual([uuid(3), uuid(5), uuid(7)]);
    // exactly at nextAttemptAt the record is due
    expect((await db.claimDue(new Date(T0 + 1001), 10)).map((r) => r.id)).toEqual([
      uuid(1),
      uuid(2),
      uuid(3),
      uuid(5),
      uuid(7),
    ]);
  });
  it('dead-lettered record blocks later events of its key', async () => {
    const db = new MemoryDatabase();
    await seed(db, rec(1, { orderingKey: 'a' }, T0), rec(2, { orderingKey: 'a' }, T0 + 1));
    await db.deadLetter(uuid(1), { error: 'e', attempts: 3, at: new Date(T0) });
    expect(await db.claimDue(new Date(T0 + 10), 10)).toEqual([]);
  });
  it('state updates write the documented fields', async () => {
    const db = new MemoryDatabase();
    await seed(db, rec(1), rec(2), rec(3));
    const at = new Date(T0 + 5);
    await db.recordFailure(uuid(1), { error: 'boom', attempts: 2, nextAttemptAt: at });
    expect(db.allOutbox().find((r) => r.id === uuid(1))).toMatchObject({
      publishAttempts: 2,
      lastError: 'boom',
      nextAttemptAt: at,
      publishedAt: null,
      deadLetteredAt: null,
    });
    await db.markPublished(uuid(1), at);
    expect(db.allOutbox().find((r) => r.id === uuid(1))).toMatchObject({
      publishedAt: at,
      nextAttemptAt: null,
      lastError: null,
    });
    await db.deadLetter(uuid(2), { error: 'dead', attempts: 3, at });
    expect(db.allOutbox().find((r) => r.id === uuid(2))).toMatchObject({
      publishAttempts: 3,
      lastError: 'dead',
      deadLetteredAt: at,
    });
  });
  it('unknown ids are reported with their id', async () => {
    const db = new MemoryDatabase();
    const missing = uuid(99);
    await expect(Promise.resolve().then(() => db.markPublished(missing, new Date(T0)))).rejects.toThrow(
      UnknownOutboxEventError,
    );
    await expect(Promise.resolve().then(() => db.markPublished(missing, new Date(T0)))).rejects.toThrow(
      `unknown outbox event ${missing}`,
    );
    await expect(db.replay(missing, new Date(T0))).rejects.toThrow(UnknownOutboxEventError);
    await expect(db.replay(missing, new Date(T0))).rejects.toThrow(`unknown outbox event ${missing}`);
  });
  it('listDeadLettered filters, sorts and limits; replay validates state', async () => {
    const db = new MemoryDatabase();
    await seed(db, rec(1, {}, T0 + 3), rec(2, {}, T0 + 1), rec(3, {}, T0 + 2), rec(4), rec(5, {}, T0 + 4));
    const at = new Date(T0 + 50);
    for (const n of [1, 2, 3, 5]) await db.deadLetter(uuid(n), { error: 'e', attempts: 3, at });
    await db.markPublished(uuid(5), at); // dead AND published: not listed, not replayable
    expect((await db.listDeadLettered(10)).map((r) => r.id)).toEqual([uuid(2), uuid(3), uuid(1)]);
    expect((await db.listDeadLettered(2)).map((r) => r.id)).toEqual([uuid(2), uuid(3)]);
    await expect(db.replay(uuid(4), at)).rejects.toThrow(InvalidReplayError); // healthy
    await expect(db.replay(uuid(4), at)).rejects.toThrow(`outbox event ${uuid(4)} is not dead-lettered`);
    await expect(db.replay(uuid(5), at)).rejects.toThrow(InvalidReplayError); // published
    await db.replay(uuid(2), at);
    expect(db.allOutbox().find((r) => r.id === uuid(2))).toMatchObject({
      deadLetteredAt: null,
      publishAttempts: 0,
      nextAttemptAt: null,
    });
  });
});

// ---------------------------------------------------------------- relay
describe('OutboxRelay exact behaviour', () => {
  const mk = (cfg = CFG, random = () => 0) => {
    const db = new MemoryDatabase();
    const clock = new FakeClock(T0);
    const broker = new MemoryBroker();
    const relay = new OutboxRelay({ store: db, publisher: broker, clock, random }, cfg);
    return { db, clock, broker, relay };
  };
  const emit = async (db: MemoryDatabase, id: number, over: Partial<NewOutboxEvent> = {}, at = T0): Promise<void> => {
    await db.run(async (tx) => {
      await db.append(
        tx,
        createOutboxRecord(
          { aggregateType: 'order_group', aggregateId: uuid(100 + id), eventType: 'order_group.paid', payload: {}, ...over },
          { id: uuid(id), now: new Date(at) },
        ),
      );
    });
  };
  const get = (db: MemoryDatabase, id: number): OutboxRecord => {
    const r = db.allOutbox().find((x) => x.id === uuid(id));
    if (r === undefined) throw new Error('missing');
    return r;
  };

  it('validates config with messages and boundaries', () => {
    const deps = { store: new MemoryDatabase(), publisher: new MemoryBroker(), clock: new FakeClock(T0), random: () => 0 };
    expect(() => new OutboxRelay(deps, { ...CFG, batchSize: 0 })).toThrow('batchSize must be an integer >= 1');
    expect(() => new OutboxRelay(deps, { ...CFG, batchSize: 1.5 })).toThrow(InvalidConfigError);
    expect(() => new OutboxRelay(deps, { ...CFG, batchSize: 1 })).not.toThrow();
    expect(() => new OutboxRelay(deps, { ...CFG, maxAttempts: 0 })).toThrow('maxAttempts must be an integer >= 1');
    expect(() => new OutboxRelay(deps, { ...CFG, maxAttempts: 2.5 })).toThrow(InvalidConfigError);
    expect(() => new OutboxRelay(deps, { ...CFG, maxAttempts: 1 })).not.toThrow();
    expect(() => new OutboxRelay(deps, { ...CFG, backoff: { baseMs: 0, capMs: 1 } })).toThrow(InvalidConfigError);
  });
  it('toMessage copies exactly the message fields', () => {
    const r = createOutboxRecord(
      { aggregateType: 'a', aggregateId: uuid(2), eventType: 'a.b', eventVersion: 3, orderingKey: 'k', payload: { p: 1 }, headers: { h: 'x' } },
      { id: uuid(1), now: new Date(T0) },
    );
    expect(toMessage(r)).toEqual({
      messageId: uuid(1),
      occurredAt: new Date(T0),
      aggregateType: 'a',
      aggregateId: uuid(2),
      eventType: 'a.b',
      eventVersion: 3,
      orderingKey: 'k',
      payload: { p: 1 },
      headers: { h: 'x' },
    });
  });
  it('schedules retry at now + backoff and records the error text', async () => {
    const { db, broker, relay } = mk();
    await emit(db, 1);
    broker.failWith = () => new TypeError('boom');
    const rep = await relay.runOnce();
    expect(rep).toEqual({ published: 0, retryScheduled: 1, deadLettered: 0, skippedForOrdering: 0 });
    expect(get(db, 1)).toMatchObject({
      publishAttempts: 1,
      lastError: 'TypeError: boom',
      nextAttemptAt: new Date(T0 + 500),
      deadLetteredAt: null,
    });
  });
  it('records a placeholder for non-Error throws', async () => {
    const { db, broker, relay } = mk();
    await emit(db, 1);
    broker.failWith = () => 'str' as unknown as Error;
    await relay.runOnce();
    expect(get(db, 1).lastError).toBe('non-error thrown');
  });
  it('truncates error text to exactly 500 chars and leaves 500 intact', async () => {
    const { db, broker, relay } = mk();
    await emit(db, 1);
    await emit(db, 2, {}, T0 + 1);
    // text = "Error: " + message
    broker.failWith = () => new Error('m'.repeat(493)); // total 500
    await relay.runOnce();
    expect(get(db, 1).lastError).toHaveLength(500);
    expect(get(db, 1).lastError).toBe(`Error: ${'m'.repeat(493)}`);
    const t = mk();
    await emit(t.db, 1);
    t.broker.failWith = () => new Error('m'.repeat(494)); // total 501 -> cut to 500
    await t.relay.runOnce();
    expect(get(t.db, 1).lastError).toBe(`Error: ${'m'.repeat(493)}`);
  });
  it('dead-letters at maxAttempts and immediately on PermanentPublishError', async () => {
    const one = mk({ ...CFG, maxAttempts: 1 });
    await emit(one.db, 1);
    one.broker.failWith = () => new Error('x');
    expect(await one.relay.runOnce()).toEqual({ published: 0, retryScheduled: 0, deadLettered: 1, skippedForOrdering: 0 });
    expect(get(one.db, 1)).toMatchObject({ publishAttempts: 1, deadLetteredAt: new Date(T0), lastError: 'Error: x' });

    const perm = mk();
    await emit(perm.db, 1);
    perm.broker.failWith = () => new PermanentPublishError('bad');
    expect((await perm.relay.runOnce()).deadLettered).toBe(1);
    expect(get(perm.db, 1).publishAttempts).toBe(1);
  });
  it('does not block records without an ordering key and skips same-key successors', async () => {
    const { db, broker, relay } = mk();
    await emit(db, 1, { orderingKey: null }, T0);
    await emit(db, 2, { orderingKey: null }, T0 + 1);
    await emit(db, 3, { orderingKey: 'k' }, T0 + 2);
    await emit(db, 4, { orderingKey: 'k' }, T0 + 3);
    let n = 0;
    broker.failWith = () => (++n === 1 || n === 3 ? new Error('f') : null);
    const rep = await relay.runOnce();
    // 1 fails, 2 published (null key not blocked), 3 fails, 4 skipped
    expect(rep).toEqual({ published: 1, retryScheduled: 2, deadLettered: 0, skippedForOrdering: 1 });
    expect(get(db, 2).publishedAt).toEqual(new Date(T0));
    expect(get(db, 4).publishedAt).toBeNull();
    expect(get(db, 4).publishAttempts).toBe(0);
  });
  it('replay and replayAll honour limits and return counts', async () => {
    const { db, clock, relay } = mk();
    for (const n of [1, 2, 3]) await emit(db, n, {}, T0 + n);
    for (const n of [1, 2, 3]) await db.deadLetter(uuid(n), { error: 'e', attempts: 3, at: clock.now() });
    expect(await relay.replayAll(2)).toBe(2);
    expect(get(db, 3).deadLetteredAt).not.toBeNull();
    expect(get(db, 1).deadLetteredAt).toBeNull();
    expect(await relay.replayAll()).toBe(1);
    expect(await relay.replayAll()).toBe(0);
    await db.deadLetter(uuid(1), { error: 'e', attempts: 3, at: clock.now() });
    await relay.replay(uuid(1));
    expect(get(db, 1).deadLetteredAt).toBeNull();
  });
});

// ---------------------------------------------------------------- saga
const c = (name: string): SagaStep => ({ name, kind: 'compensatable', command: `do.${name}`, compensation: `undo.${name}` });
const p = (name: string): SagaStep => ({ name, kind: 'pivot', command: `do.${name}`, compensation: null });
const r = (name: string): SagaStep => ({ name, kind: 'retriable', command: `do.${name}`, compensation: null });
const def = (name: string, ...steps: SagaStep[]): SagaDefinition => ({ name, steps });

describe('defineSaga validation', () => {
  it('returns the same definition when valid', () => {
    const d = def('ok', c('a'), c('b'), p('p'), r('r1'), r('r2'));
    expect(defineSaga(d)).toBe(d);
    expect(() => defineSaga(def('only_c', c('a')))).not.toThrow();
    expect(() => defineSaga(def('only_r', r('a'), r('b')))).not.toThrow(); // no pivot: retriable allowed
    expect(() => defineSaga(def('pivot_first', p('p'), r('r')))).not.toThrow();
    expect(() => defineSaga(def('pivot_only', p('p')))).not.toThrow();
  });
  it('rejects each malformed shape with its message', () => {
    expect(() => defineSaga(def('x'))).toThrow('x: no steps');
    expect(() => defineSaga(def('x', c('a'), c('a')))).toThrow('x: duplicate step a');
    expect(() =>
      defineSaga(def('x', { name: 'a', kind: 'compensatable', command: 'c', compensation: null })),
    ).toThrow('a: compensatable step needs a compensation');
    expect(() => defineSaga(def('x', p('p'), c('b')))).toThrow(
      'b: compensatable step after pivot or retriable step',
    );
    expect(() => defineSaga(def('x', r('r'), c('b')))).toThrow(
      'b: compensatable step after pivot or retriable step',
    );
    expect(() =>
      defineSaga(def('x', { name: 'p', kind: 'pivot', command: 'c', compensation: 'u' })),
    ).toThrow('p: pivot step must not have a compensation');
    expect(() =>
      defineSaga(def('x', { name: 'q', kind: 'retriable', command: 'c', compensation: 'u' })),
    ).toThrow('q: retriable step must not have a compensation');
    expect(() => defineSaga(def('x', r('r'), p('p')))).toThrow('r: retriable step before pivot');
    expect(() => defineSaga(def('x', p('p1'), r('r'), p('p2')))).toThrow('p2: pivot after retriable step');
    expect(() => defineSaga(def('x', p('p1'), p('p2')))).toThrow('x: more than one pivot');
    expect(() => defineSaga(def('x', p('p1'), p('p2')))).toThrow(InvalidSagaDefinitionError);
  });
});

describe('saga reducer exact behaviour', () => {
  const D = def('d', c('c1'), c('c2'), p('pv'), r('r1'));
  const ok = (step: string) => ({ type: 'step_succeeded', step }) as const;
  const fail = (step: string, retryable = false) =>
    ({ type: 'step_failed', step, reason: 'why', retryable }) as const;
  const run = (st: SagaState, ...evs: Parameters<typeof applyEvent>[2][]): SagaState =>
    evs.reduce((s, e) => applyEvent(D, s, e), st);
  const fresh = (): SagaState => startSaga(D, 's1');

  it('startSaga exact shape', () => {
    expect(fresh()).toEqual({
      sagaId: 's1',
      definition: 'd',
      status: 'running',
      completedSteps: [],
      compensatedSteps: [],
      failedStep: null,
      failureReason: null,
      stuckReason: null,
    });
  });
  it('nextCommand across statuses', () => {
    expect(nextCommand(D, fresh())).toEqual({ kind: 'execute', step: 'c1', command: 'do.c1' });
    expect(nextCommand(D, run(fresh(), ok('c1')))).toEqual({ kind: 'execute', step: 'c2', command: 'do.c2' });
    const all: SagaState = { ...fresh(), completedSteps: ['c1', 'c2', 'pv', 'r1'] };
    expect(nextCommand(D, all)).toBeNull(); // running but nothing left
    expect(nextCommand(D, { ...all, status: 'completed' })).toBeNull();
    expect(nextCommand(D, { ...all, status: 'compensated' })).toBeNull();
    expect(nextCommand(D, { ...all, status: 'stuck' })).toBeNull();
    const comp = run(fresh(), ok('c1'), ok('c2'), fail('pv'));
    expect(comp.status).toBe('compensating');
    expect(nextCommand(D, comp)).toEqual({ kind: 'compensate', step: 'c2', command: 'undo.c2' });
    expect(nextCommand(D, { ...fresh(), status: 'compensating' })).toBeNull(); // nothing pending
    const noComp: SagaDefinition = { name: 'n', steps: [{ name: 'a', kind: 'compensatable', command: 'x', compensation: null }] };
    expect(
      nextCommand(noComp, { ...startSaga(noComp, 's'), status: 'compensating', completedSteps: ['a'] }),
    ).toBeNull();
  });
  it('step_succeeded: order, duplicates, completion, unknown step', () => {
    const s1 = run(fresh(), ok('c1'));
    expect(s1.completedSteps).toEqual(['c1']);
    expect(applyEvent(D, s1, ok('c1'))).toBe(s1);
    expect(() => applyEvent(D, fresh(), ok('c2'))).toThrow('d: c2 succeeded out of order');
    expect(() => applyEvent(D, fresh(), ok('c2'))).toThrow(InvalidSagaTransitionError);
    expect(() => applyEvent(D, fresh(), ok('zzz'))).toThrow('d: unknown step zzz');
    const done = run(fresh(), ok('c1'), ok('c2'), ok('pv'), ok('r1'));
    expect(done.status).toBe('completed');
    expect(run(fresh(), ok('c1'), ok('c2'), ok('pv')).status).toBe('running');
    expect(() => applyEvent(D, { ...fresh(), status: 'compensated' }, ok('c1'))).toThrow(
      'd: step_succeeded c1 in status compensated',
    );
  });
  it('step_failed before the pivot compensates what exists', () => {
    const f = run(fresh(), ok('c1'), fail('c2'));
    expect(f).toMatchObject({
      status: 'compensating',
      failedStep: 'c2',
      failureReason: 'why',
      completedSteps: ['c1'],
      stuckReason: null,
    });
    const first = run(fresh(), fail('c1'));
    expect(first).toMatchObject({ status: 'compensated', failedStep: 'c1', failureReason: 'why' });
    const retry = run(fresh(), ok('c1'));
    expect(applyEvent(D, retry, fail('c2', true))).toBe(retry);
  });
  it('step_failed after the pivot, or of a retriable step, gets stuck', () => {
    const s = run(fresh(), ok('c1'), ok('c2'), ok('pv'), fail('r1'));
    expect(s).toMatchObject({
      status: 'stuck',
      failedStep: 'r1',
      failureReason: 'why',
      stuckReason: 'r1 failed permanently after the pivot; forward recovery or manual action required',
    });
    const noPivot = def('np', c('a'), r('b'));
    const st = applyEvent(noPivot, applyEvent(noPivot, startSaga(noPivot, 's'), ok('a')), fail('b'));
    expect(st.status).toBe('stuck');
  });
  it('step_failed when not running is idempotent only for known steps', () => {
    const comp = run(fresh(), ok('c1'), fail('c2'));
    expect(applyEvent(D, comp, fail('c2'))).toBe(comp); // same failed step
    expect(applyEvent(D, comp, fail('c1'))).toBe(comp); // completed step
    expect(() => applyEvent(D, comp, fail('r1'))).toThrow('d: step_failed r1 in status compensating');
  });
  it('late success of the failed step', () => {
    const comp = run(fresh(), ok('c1'), fail('c2'));
    const late = applyEvent(D, comp, ok('c2'));
    expect(late.status).toBe('compensating');
    expect(late.completedSteps).toEqual(['c1', 'c2']);
    expect(nextCommand(D, late)).toEqual({ kind: 'compensate', step: 'c2', command: 'undo.c2' });
    expect(() => applyEvent(D, comp, ok('pv'))).toThrow('d: step_succeeded pv in status compensating');
    // pivot succeeded late: cannot be undone
    const pivotFail = run(fresh(), ok('c1'), ok('c2'), fail('pv'));
    const lateP = applyEvent(D, pivotFail, ok('pv'));
    expect(lateP.status).toBe('stuck');
    expect(lateP.completedSteps).toEqual(['c1', 'c2', 'pv']);
    expect(lateP.stuckReason).toBe('pv completed after compensation began and cannot be undone by this saga');
  });
  it('compensation sequence in reverse order, with duplicates and errors', () => {
    const comp = run(fresh(), ok('c1'), ok('c2'), fail('pv'));
    const a = applyEvent(D, comp, { type: 'compensation_succeeded', step: 'c2' });
    expect(a.status).toBe('compensating');
    expect(a.compensatedSteps).toEqual(['c2']);
    expect(applyEvent(D, a, { type: 'compensation_succeeded', step: 'c2' })).toBe(a);
    expect(nextCommand(D, a)).toEqual({ kind: 'compensate', step: 'c1', command: 'undo.c1' });
    const b = applyEvent(D, a, { type: 'compensation_succeeded', step: 'c1' });
    expect(b.status).toBe('compensated');
    expect(b.compensatedSteps).toEqual(['c2', 'c1']);
    expect(nextCommand(D, b)).toBeNull();
    expect(() => applyEvent(D, fresh(), { type: 'compensation_succeeded', step: 'c1' })).toThrow(
      'd: compensation_succeeded c1 not expected',
    );
    expect(() => applyEvent(D, comp, { type: 'compensation_succeeded', step: 'r1' })).toThrow(
      InvalidSagaTransitionError,
    );
    // status compensating but step never completed
    const early = run(fresh(), ok('c1'), fail('c2'));
    expect(() => applyEvent(D, early, { type: 'compensation_succeeded', step: 'c2' })).toThrow(
      'compensation_succeeded c2 not expected',
    );
  });
  it('compensation_failed', () => {
    const comp = run(fresh(), ok('c1'), fail('c2'));
    expect(applyEvent(D, comp, { type: 'compensation_failed', step: 'c1', reason: 'r', retryable: true })).toBe(comp);
    const s = applyEvent(D, comp, { type: 'compensation_failed', step: 'c1', reason: 'net', retryable: false });
    expect(s.status).toBe('stuck');
    expect(s.stuckReason).toBe('compensation of c1 failed permanently: net');
    const running = fresh();
    expect(
      applyEvent(D, running, { type: 'compensation_failed', step: 'c1', reason: 'r', retryable: false }),
    ).toBe(running);
  });
});

describe('saga reducer edge guards', () => {
  const D = def('d', c('c1'), c('c2'), p('pv'), r('r1'));
  const base = (): SagaState => startSaga(D, 's1');
  it('late success is not accepted once compensation finished with nothing to undo', () => {
    const done = applyEvent(D, base(), { type: 'step_failed', step: 'c1', reason: 'x', retryable: false });
    expect(done.status).toBe('compensated');
    expect(() => applyEvent(D, done, { type: 'step_succeeded', step: 'c1' })).toThrow(
      'd: step_succeeded c1 in status compensated',
    );
  });
  it('compensation_succeeded needs the compensating status even if the step completed', () => {
    const running: SagaState = { ...base(), completedSteps: ['c1'] };
    expect(() => applyEvent(D, running, { type: 'compensation_succeeded', step: 'c1' })).toThrow(
      'd: compensation_succeeded c1 not expected',
    );
  });
  it('only compensatable steps are pending compensations', () => {
    const st: SagaState = { ...base(), status: 'compensating', completedSteps: ['c1', 'pv'] };
    expect(nextCommand(D, st)).toEqual({ kind: 'compensate', step: 'c1', command: 'undo.c1' });
  });
  it('a failure after a completed pivot is stuck even for a (malformed) compensatable step', () => {
    const raw: SagaDefinition = { name: 'raw', steps: [c('c1'), p('pv'), c('c2')] };
    const st: SagaState = { ...startSaga(raw, 's'), completedSteps: ['c1', 'pv'] };
    const next = applyEvent(raw, st, { type: 'step_failed', step: 'c2', reason: 'x', retryable: false });
    expect(next.status).toBe('stuck');
  });
});
