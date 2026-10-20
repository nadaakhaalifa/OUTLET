import { InvalidOutboxRecordError } from './errors.js';

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** Row of `outbox_events`. See README for the column mapping. */
export interface OutboxRecord {
  readonly id: string;
  readonly occurredAt: Date;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly orderingKey: string | null;
  readonly payload: JsonObject;
  readonly headers: JsonObject;
  readonly publishedAt: Date | null;
  readonly publishAttempts: number;
  readonly lastError: string | null;
  /** Relay bookkeeping not yet in migration 0004: see README "Column contract". */
  readonly nextAttemptAt: Date | null;
  readonly deadLetteredAt: Date | null;
}

export interface NewOutboxEvent {
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly eventVersion?: number;
  /** Defaults to `${aggregateType}:${aggregateId}`: events of one aggregate relay in order. */
  readonly orderingKey?: string | null;
  readonly payload: JsonObject;
  readonly headers?: JsonObject;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EVENT_TYPE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

function assertJson(value: unknown, path: string): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new InvalidOutboxRecordError(`${path}: non-finite number`);
    return;
  }
  if (typeof value === 'bigint') {
    throw new InvalidOutboxRecordError(`${path}: bigint is not JSON; serialise money minor units as a string`);
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertJson(v, `${path}[${i}]`));
    return;
  }
  if (typeof value === 'object' && !(value instanceof Date)) {
    for (const [k, v] of Object.entries(value)) assertJson(v, `${path}.${k}`);
    return;
  }
  throw new InvalidOutboxRecordError(`${path}: value is not JSON-serialisable`);
}

/**
 * Validates an event and builds the unpublished record. `id` (uuidv7) and
 * `now` are injected so this stays pure. Boundary validation is hand-written
 * because zod is not a dependency of this package yet (see needsDeps).
 */
export function createOutboxRecord(
  event: NewOutboxEvent,
  ctx: { readonly id: string; readonly now: Date },
): OutboxRecord {
  if (!isUuid(ctx.id)) throw new InvalidOutboxRecordError('id must be a lowercase uuid');
  if (event.aggregateType.length === 0) throw new InvalidOutboxRecordError('aggregateType is empty');
  if (!isUuid(event.aggregateId)) throw new InvalidOutboxRecordError('aggregateId must be a lowercase uuid');
  if (!EVENT_TYPE.test(event.eventType)) {
    throw new InvalidOutboxRecordError('eventType must look like "order_group.paid"');
  }
  const eventVersion = event.eventVersion ?? 1;
  if (!Number.isInteger(eventVersion) || eventVersion < 1) {
    throw new InvalidOutboxRecordError('eventVersion must be an integer >= 1');
  }
  if (Number.isNaN(ctx.now.getTime())) throw new InvalidOutboxRecordError('invalid timestamp');
  assertJson(event.payload, 'payload');
  const headers = event.headers ?? {};
  assertJson(headers, 'headers');
  const orderingKey =
    event.orderingKey === undefined ? `${event.aggregateType}:${event.aggregateId}` : event.orderingKey;
  if (orderingKey !== null && orderingKey.length === 0) {
    throw new InvalidOutboxRecordError('orderingKey must be null or non-empty');
  }
  return {
    id: ctx.id,
    occurredAt: ctx.now,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    eventType: event.eventType,
    eventVersion,
    orderingKey,
    payload: event.payload,
    headers,
    publishedAt: null,
    publishAttempts: 0,
    lastError: null,
    nextAttemptAt: null,
    deadLetteredAt: null,
  };
}
