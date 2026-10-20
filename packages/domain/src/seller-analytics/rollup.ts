/**
 * Hourly rollup arithmetic (dashboard foundations track 6, ADR-0045). Pure: no I/O, no clock, no Cairo tables.
 * The caller injects `bucketOf` (the Africa/Cairo hour bucket, `cairoHourBucket` in the time package) so this
 * file stays inside the seller-analytics import boundary.
 *
 * Money is bigint piastres. A delta may be negative only for the `orders` metric when an earlier purchase fact
 * arrives after a later one (the order moves to the earlier hour); the net sum per key is never negative.
 */

export const SELLER_ROLLUP_METRICS = [
  "gmv_minor",
  "commission_minor",
  "orders",
  "units",
  "store_views",
  "product_views",
  "impressions",
  "saves",
  "bags",
  "checkouts",
  "purchases",
  "returned_units",
] as const;
export type SellerRollupMetric = (typeof SELLER_ROLLUP_METRICS)[number];

export const PLATFORM_ROLLUP_METRICS = [
  "orders_placed",
  "seller_orders_placed",
  "orders_purchased",
  "units_purchased",
  "gmv_purchased_minor",
] as const;
export type PlatformRollupMetric = (typeof PLATFORM_ROLLUP_METRICS)[number];

/** Platform metrics that can be derived from facts alone today (the others need order-group ids, track 5). */
export const PLATFORM_FACT_METRICS: readonly PlatformRollupMetric[] = ["units_purchased", "gmv_purchased_minor"];

export type RollupScope = "seller" | "platform";

export interface HourBucket {
  readonly hourUtcMs: number;
  readonly cairoDate: string;
  readonly cairoHour: number;
  readonly utcOffsetMin: 120 | 180;
}
export type HourBucketFn = (ms: number) => HourBucket;

export interface RollupKey {
  readonly scope: RollupScope;
  /** Null for platform rows. */
  readonly storeId: string | null;
  readonly metric: string;
  readonly hourUtcMs: number;
}

export interface RollupDelta {
  readonly key: RollupKey;
  readonly delta: bigint;
}

/** The structural subset of a source event that feeds rollups (SourceEvent satisfies it). */
export interface RollupFact {
  readonly kind: string;
  readonly storeId: string;
  readonly occurredAtMs: number;
  readonly qty?: number;
  readonly grossMinor?: bigint;
  readonly commissionMinor?: bigint;
}

const HOUR_MS = 3_600_000;
export const hourStart = (ms: number): number => Math.floor(ms / HOUR_MS) * HOUR_MS;

/** Total order on keys. Every writer sorts by this before taking advisory locks, so lock order is consistent. */
export const keyString = (k: RollupKey): string => `${k.scope}|${k.storeId ?? "-"}|${k.metric}|${String(k.hourUtcMs).padStart(16, "0")}`;
export const compareKeys = (a: RollupKey, b: RollupKey): number => {
  const x = keyString(a);
  const y = keyString(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

const seller = (storeId: string, metric: SellerRollupMetric, ms: number, delta: bigint): RollupDelta => ({
  key: { scope: "seller", storeId, metric, hourUtcMs: hourStart(ms) },
  delta,
});
const platform = (metric: PlatformRollupMetric, ms: number, delta: bigint): RollupDelta => ({
  key: { scope: "platform", storeId: null, metric, hourUtcMs: hourStart(ms) },
  delta,
});

const COUNTED: Readonly<Record<string, SellerRollupMetric>> = {
  store_view: "store_views",
  view: "product_views",
  impression: "impressions",
  save: "saves",
  bag: "bags",
  checkout: "checkouts",
};

/**
 * Additive deltas of one fact in the bucket of its own `occurredAtMs` (late events land in their own bucket).
 * `orders` is not here: counting a seller order once needs the fact history, see `orderDeltas`.
 */
export function factDeltas(f: RollupFact): readonly RollupDelta[] {
  const counted = COUNTED[f.kind];
  if (counted !== undefined) return [seller(f.storeId, counted, f.occurredAtMs, 1n)];
  if (f.kind === "purchase") {
    const gross = f.grossMinor ?? 0n;
    const commission = f.commissionMinor ?? 0n;
    const qty = BigInt(f.qty ?? 0);
    return [
      seller(f.storeId, "gmv_minor", f.occurredAtMs, gross),
      seller(f.storeId, "commission_minor", f.occurredAtMs, commission),
      seller(f.storeId, "units", f.occurredAtMs, qty),
      seller(f.storeId, "purchases", f.occurredAtMs, 1n),
      platform("units_purchased", f.occurredAtMs, qty),
      platform("gmv_purchased_minor", f.occurredAtMs, gross),
    ];
  }
  if (f.kind === "return") return [seller(f.storeId, "returned_units", f.occurredAtMs, BigInt(f.qty ?? 0))];
  return [];
}

/**
 * `orders` counts a seller order once, in the hour of its EARLIEST purchase fact (the definition the
 * reconciler recomputes). `prevMinMs` is the earliest existing purchase fact of the same (store, order) before
 * this one is inserted, or null when this is the first. Out-of-order delivery moves the order to the earlier hour.
 */
export function orderDeltas(storeId: string, prevMinMs: number | null, thisMs: number): readonly RollupDelta[] {
  if (prevMinMs === null) return [seller(storeId, "orders", thisMs, 1n)];
  if (thisMs >= prevMinMs || hourStart(thisMs) === hourStart(prevMinMs)) return [];
  return [seller(storeId, "orders", prevMinMs, -1n), seller(storeId, "orders", thisMs, 1n)];
}

/** Merges deltas per key, drops zero sums and returns them in `compareKeys` order. */
export function aggregateDeltas(ds: readonly RollupDelta[]): readonly RollupDelta[] {
  const sums = new Map<string, RollupDelta>();
  for (const d of ds) {
    const k = keyString(d.key);
    const cur = sums.get(k);
    sums.set(k, { key: d.key, delta: (cur?.delta ?? 0n) + d.delta });
  }
  return [...sums.values()].filter((d) => d.delta !== 0n).sort((a, b) => compareKeys(a.key, b.key));
}

/** Rollup row as stored. `value` is published, `held` is parked by the anomaly guard; facts equal `value + held`. */
export interface RollupRowState {
  readonly value: bigint;
  readonly held: bigint;
  readonly version: bigint;
}

export type RollupDiff =
  | { readonly kind: "existing"; readonly key: RollupKey; readonly expected: bigint; readonly actual: RollupRowState }
  | { readonly kind: "new_key"; readonly key: RollupKey; readonly expected: bigint };

/**
 * Compares the facts aggregation with the rollup rows of the same window. A row with no facts is expected to be 0.
 * Only differences are returned, sorted by key.
 */
export function diffRollups(
  expected: ReadonlyMap<string, { readonly key: RollupKey; readonly total: bigint }>,
  actual: ReadonlyMap<string, { readonly key: RollupKey; readonly state: RollupRowState }>,
): readonly RollupDiff[] {
  const out: RollupDiff[] = [];
  for (const [k, a] of actual) {
    const want = expected.get(k)?.total ?? 0n;
    if (a.state.value + a.state.held !== want) out.push({ kind: "existing", key: a.key, expected: want, actual: a.state });
  }
  for (const [k, e] of expected) if (!actual.has(k) && e.total !== 0n) out.push({ kind: "new_key", key: e.key, expected: e.total });
  return out.sort((a, b) => compareKeys(a.key, b.key));
}

/**
 * Value to publish after a repair: the recomputed total is split so that the held part is preserved when it
 * still fits (held increments belong to the anomaly guard, track 5), the rest is published.
 */
export function repairedValues(expected: bigint, heldBefore: bigint): { readonly value: bigint; readonly held: bigint } {
  const held = heldBefore > expected ? expected : heldBefore;
  return { value: expected - held, held };
}

export interface AggregatableFact extends RollupFact {
  readonly sellerOrderId?: string;
}

/**
 * The facts side of reconciliation, as a pure function: what the rollups of `scope` must equal for the hours in
 * `[fromMs, toMs)`. `orders` is counted once per (store, seller order) in the hour of its earliest purchase fact,
 * taken over ALL given facts (not only the window), exactly like the SQL the Postgres adapter runs.
 */
export function aggregateFacts(
  scope: RollupScope,
  facts: readonly AggregatableFact[],
  fromMs: number,
  toMs: number,
): Map<string, { readonly key: RollupKey; readonly total: bigint }> {
  const inWindow = (ms: number): boolean => ms >= fromMs && ms < toMs;
  const sums = new Map<string, { key: RollupKey; total: bigint }>();
  const add = (d: RollupDelta): void => {
    if (d.key.scope !== scope || !inWindow(d.key.hourUtcMs)) return;
    const k = keyString(d.key);
    const cur = sums.get(k);
    sums.set(k, { key: d.key, total: (cur?.total ?? 0n) + d.delta });
  };
  const firstByOrder = new Map<string, { storeId: string; ms: number }>();
  for (const f of facts) {
    for (const d of factDeltas(f)) add(d);
    if (f.kind === "purchase" && f.sellerOrderId !== undefined) {
      const k = `${f.storeId}|${f.sellerOrderId}`;
      const cur = firstByOrder.get(k);
      if (cur === undefined || f.occurredAtMs < cur.ms) firstByOrder.set(k, { storeId: f.storeId, ms: f.occurredAtMs });
    }
  }
  if (scope === "seller") for (const o of firstByOrder.values()) add({ key: { scope: "seller", storeId: o.storeId, metric: "orders", hourUtcMs: hourStart(o.ms) }, delta: 1n });
  for (const [k, v] of sums) if (v.total === 0n) sums.delete(k);
  return sums;
}
