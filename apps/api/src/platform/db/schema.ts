import type { ColumnType, Generated, GeneratedAlways } from "kysely";
import type { JsonObject } from "./deps";

/**
 * Hand-written Kysely row types for the PLATFORM tables (ADR-0020, option A).
 * Source of truth is packages/db/migrations; `schema-drift.test.ts` fails when
 * a column list below disagrees with information_schema.
 *
 * Driver notes
 *   - timestamptz -> Date, uuid -> string, jsonb -> parsed JSON on read.
 *   - jsonb is WRITTEN as a JSON string (JSON.stringify) so arrays and objects
 *     bind identically on pg and PGlite.
 *   - bigint (int8) columns read back as string on pg. Never use Number() for
 *     money: coerce with `toBigInt`.
 *   - bytea -> Buffer (pg) or Uint8Array (PGlite): type as Uint8Array.
 */
type Json = ColumnType<JsonObject, string, string>;

export interface UsersTable {
  id: Generated<string>;
  status: Generated<"pending" | "active" | "suspended" | "deleted">;
  locale: Generated<"ar" | "en">;
  country: Generated<string>;
  age_attested_18_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  deleted_at: Date | null;
}

export interface ConsentRecordsTable {
  id: Generated<string>;
  seq: GeneratedAlways<string>;
  subject_type: "user" | "device";
  subject_id: string;
  purpose: string;
  version: number;
  granted: boolean;
  method: "onboarding" | "settings" | "prompt" | "api";
  occurred_at: Generated<Date>;
  ip_hash: string | null;
  app_version: string | null;
}

export interface OutboxEventsTable {
  id: string;
  occurred_at: Generated<Date>;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  event_version: Generated<number>;
  ordering_key: string | null;
  payload: Json;
  headers: ColumnType<JsonObject, string | undefined, string>;
  published_at: Date | null;
  publish_attempts: Generated<number>;
  last_error: string | null;
  next_attempt_at: Date | null;
  dead_lettered_at: Date | null;
}

export interface InboxProcessedTable {
  consumer: string;
  message_id: string;
  processed_at: Generated<Date>;
}

export interface IdempotencyKeysTable {
  actor_id: string;
  route: string;
  key: string;
  request_hash: Uint8Array;
  response_status: number | null;
  response_body: ColumnType<JsonObject | null, string | null, string | null>;
  locked_until: Date | null;
  created_at: Generated<Date>;
  expires_at: Date;
}

/** Tables every module may rely on. A module schema is `PlatformTables & ItsOwnTables`. */
export interface PlatformTables {
  users: UsersTable;
  consent_records: ConsentRecordsTable;
  outbox_events: OutboxEventsTable;
  inbox_processed: InboxProcessedTable;
  idempotency_keys: IdempotencyKeysTable;
}

/** Exhaustive column maps: adding a column to a row type without listing it here is a compile error. */
type Cols<T> = { readonly [K in keyof T]-?: true };

export const PLATFORM_COLUMNS = {
  users: { id: true, status: true, locale: true, country: true, age_attested_18_at: true, created_at: true, updated_at: true, deleted_at: true },
  consent_records: { id: true, seq: true, subject_type: true, subject_id: true, purpose: true, version: true, granted: true, method: true, occurred_at: true, ip_hash: true, app_version: true },
  outbox_events: { id: true, occurred_at: true, aggregate_type: true, aggregate_id: true, event_type: true, event_version: true, ordering_key: true, payload: true, headers: true, published_at: true, publish_attempts: true, last_error: true, next_attempt_at: true, dead_lettered_at: true },
  inbox_processed: { consumer: true, message_id: true, processed_at: true },
  idempotency_keys: { actor_id: true, route: true, key: true, request_hash: true, response_status: true, response_body: true, locked_until: true, created_at: true, expires_at: true },
} as const satisfies { readonly [T in keyof PlatformTables]: Cols<PlatformTables[T]> };

/** int8 arrives as string (pg) or number/bigint (PGlite). Money is bigint piastres. */
export const toBigInt = (v: string | number | bigint): bigint => {
  if (typeof v === "number" && !Number.isSafeInteger(v)) throw new RangeError("unsafe integer from driver");
  return BigInt(v);
};
