/**
 * Pure builder for the per-transaction Postgres session settings (RLS contract,
 * packages/policy/RLS.md and migration 0002/0007). No IO: the adapter in
 * apps/api/src/platform/db applies the result with set_config(name, value, true).
 */

/** Closed list of values `app.role` may take. Matches `DbRole` in @outlet/policy. */
export const DB_ROLES = [
  'customer',
  'seller',
  'ops',
  'finance',
  'trust_safety',
  'support',
  'marketing',
  'dpo',
  'security',
  'super_admin',
  'courier',
  'creator',
  'system',
] as const;
export type DbRoleName = (typeof DB_ROLES)[number];

export interface RlsSession {
  readonly userId: string | null;
  readonly role: DbRoleName | null;
  readonly storeIds?: readonly string[];
  readonly deviceId?: string | null;
}

/** Context with no identity: every RLS policy denies. */
export const ANONYMOUS_SESSION: RlsSession = { userId: null, role: null };

export class InvalidSessionError extends Error {
  public override readonly name = 'InvalidSessionError';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Statement timeout profiles (ms). `reserve` follows spec 20.2 (2 s on the
 * reserve path); `default` follows T3 (10 s default request timeout).
 */
export const STATEMENT_TIMEOUT_MS = {
  reserve: 2_000,
  read: 5_000,
  default: 10_000,
  relay: 15_000,
  batch: 60_000,
} as const;
export type TimeoutProfile = keyof typeof STATEMENT_TIMEOUT_MS;

const PROCESS_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/** `application_name` carries the business process (T8), e.g. `checkout.reserve`. Max 63 bytes. */
export const assertProcessName = (name: string): string => {
  if (name.length > 63 || !PROCESS_NAME.test(name)) {
    throw new InvalidSessionError(`process name must look like "checkout.reserve" (<= 63 chars): ${name}`);
  }
  return name;
};

/**
 * [name, value] pairs for `set_config(name, value, true)`. Unset identity is
 * the empty string, which the helper functions in 0002 read as "no identity".
 * Throws InvalidSessionError on anything that is not a lowercase uuid or a
 * known role, so a malformed value can never reach a policy.
 */
export const sessionSettings = (s: RlsSession): readonly (readonly [string, string])[] => {
  const uuid = (label: string, v: string | null | undefined): string => {
    if (v === null || v === undefined) return '';
    if (!UUID.test(v)) throw new InvalidSessionError(`${label} must be a lowercase uuid`);
    return v;
  };
  if (s.role !== null && !(DB_ROLES as readonly string[]).includes(s.role)) {
    throw new InvalidSessionError(`unknown role: ${String(s.role)}`);
  }
  const stores = (s.storeIds ?? []).map((id) => uuid('storeId', id));
  if (new Set(stores).size !== stores.length) throw new InvalidSessionError('duplicate storeIds');
  return [
    ['app.user_id', uuid('userId', s.userId)],
    ['app.role', s.role ?? ''],
    ['app.store_ids', [...stores].sort().join(',')],
    ['app.device_id', uuid('deviceId', s.deviceId)],
  ];
};
