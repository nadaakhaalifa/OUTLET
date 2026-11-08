/**
 * Pure price-window maths (master prompt 9.3, internal evidence only).
 *
 * Reference rule (EU "prior price" model, adopted by 9.3): a discount is a run of consecutive price decreases. Its reference is the
 * LOWEST price in effect during the 30 days before the FIRST reduction of the run (so raise-then-cut resets to the true low, and
 * successive discounts keep the starting reference only while the price never went back up). Documented choice over the alternative
 * "min over the trailing 30 days including today", which can never be above the current price and would make every claim impossible.
 * A run that started more than 30 days ago is the regular price again: no reference.
 * A price HELD for 30 days or more (until the next change) becomes the regular price: the next reduction starts a fresh run whose
 * reference is that held price, never an earlier one. This also makes the 61 day load slice (application/env.ts) exact: a run can
 * never chain through a step held >= 30 days, so rows older than the slice cannot change the answer.
 */
export const DAY_MS = 86_400_000;
export const WINDOW_DAYS = 30;
export const WINDOW_MS = WINDOW_DAYS * DAY_MS;

export interface PriceEventInput {
  readonly priceMinor: bigint;
  readonly validFrom: Date;
  /** Evidence id (price_events.id) carried into the order-line snapshot. */
  readonly id?: string;
}

export interface PriceWindow {
  readonly currentPrice: bigint | null;
  /** Lowest price in effect during [now-30d, now], current price included. */
  readonly low30d: bigint | null;
  readonly low30dFrom: Date | null;
  readonly firstSeenAt: Date | null;
  /** Fewer than 30 days of history (or no history): never a percentage. */
  readonly launchPrice: boolean;
  readonly lastIncreaseAt: Date | null;
  /** Current price is the lowest of [now-30d, now] AND a strictly higher price was in effect in that window (a never-changed price is not "lowest"). */
  readonly isLowest30d: boolean;
  /** Lowest price in the 30 days before the first reduction of the current run; null when there is no valid reference. */
  readonly reference: bigint | null;
  readonly referenceRunStart: Date | null;
  readonly referenceEvidenceIds: readonly string[];
}

const normalize = (events: readonly PriceEventInput[], now: Date): PriceEventInput[] => {
  const sorted = events
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.validFrom.getTime() <= now.getTime())
    .sort((a, b) => a.e.validFrom.getTime() - b.e.validFrom.getTime() || a.i - b.i)
    .map(({ e }) => e);
  const out: PriceEventInput[] = [];
  for (const e of sorted) {
    if (e.priceMinor <= 0n) throw new RangeError("price must be a positive integer of minor units");
    const last = out[out.length - 1];
    if (last?.priceMinor === e.priceMinor) continue;
    out.push(e);
  }
  return out;
};

/** Lowest price in effect during [from, to) and when it started, or null when nothing was in effect then. */
const minInRange = (ev: readonly PriceEventInput[], from: number, to: number): { price: bigint; at: Date; ids: string[] } | null => {
  const inRange: PriceEventInput[] = [];
  let inEffectAtFrom: PriceEventInput | undefined;
  for (const e of ev) {
    const t = e.validFrom.getTime();
    if (t <= from) inEffectAtFrom = e;
    else if (t < to) inRange.push(e);
  }
  if (inEffectAtFrom !== undefined && from < to) inRange.unshift(inEffectAtFrom);
  const lowest = inRange.reduce<PriceEventInput | undefined>((m, e) => (m === undefined || e.priceMinor < m.priceMinor ? e : m), undefined);
  if (lowest === undefined) return null;
  const ids: string[] = [];
  for (const e of inRange) if (e.id !== undefined) ids.push(e.id);
  return { price: lowest.priceMinor, at: lowest.validFrom, ids };
};

/** Highest price in effect during [from, to), or null when nothing was in effect then. */
const maxInRange = (ev: readonly PriceEventInput[], from: number, to: number): bigint | null => {
  let inEffectAtFrom: PriceEventInput | undefined;
  let max: bigint | null = null;
  for (const e of ev) {
    const t = e.validFrom.getTime();
    if (t <= from) inEffectAtFrom = e;
    else if (t < to && (max === null || e.priceMinor > max)) max = e.priceMinor;
  }
  if (inEffectAtFrom !== undefined && from < to && (max === null || inEffectAtFrom.priceMinor > max)) max = inEffectAtFrom.priceMinor;
  return max;
};

export interface WindowOptions {
  /** Earliest observation when `events` was truncated to a recent slice. */
  readonly firstSeenAt?: Date;
}

export const computeWindow = (events: readonly PriceEventInput[], now: Date, opts: WindowOptions = {}): PriceWindow => {
  const ev = normalize(events, now);
  const nowMs = now.getTime();
  const first = ev[0];
  const current = ev[ev.length - 1];
  const firstSeenAt = opts.firstSeenAt ?? first?.validFrom ?? null;
  if (first === undefined || current === undefined || firstSeenAt === null) {
    return { currentPrice: null, low30d: null, low30dFrom: null, firstSeenAt, launchPrice: true, lastIncreaseAt: null, isLowest30d: false, reference: null, referenceRunStart: null, referenceEvidenceIds: [] };
  }

  let lastIncreaseAt: Date | null = null;
  for (let i = ev.length - 1; i > 0; i--) {
    const e = ev[i];
    const p = ev[i - 1];
    if (e !== undefined && p !== undefined && e.priceMinor > p.priceMinor) {
      lastIncreaseAt = e.validFrom;
      break;
    }
  }

  const low = minInRange(ev, nowMs - WINDOW_MS, nowMs + 1);
  const high = maxInRange(ev, nowMs - WINDOW_MS, nowMs + 1);
  const isLowest30d = low !== null && low.price === current.priceMinor && high !== null && high > current.priceMinor;
  const launchPrice = nowMs - firstSeenAt.getTime() < WINDOW_MS;

  // Current run of consecutive decreases; the first reduction of the run sits right after index r.
  let r = ev.length - 1;
  while (r > 0 && (ev[r]?.priceMinor ?? 0n) < (ev[r - 1]?.priceMinor ?? 0n)) {
    r--;
    // The base price was held >= 30 days: it is the regular price, the run cannot extend before it.
    if ((ev[r + 1]?.validFrom.getTime() ?? 0) - (ev[r]?.validFrom.getTime() ?? 0) >= WINDOW_MS) break;
  }
  const runFirst = ev[r + 1];
  let reference: bigint | null = null;
  let referenceRunStart: Date | null = null;
  let referenceEvidenceIds: string[] = [];
  if (runFirst !== undefined) {
    const runStart = runFirst.validFrom.getTime();
    const from = runStart - WINDOW_MS;
    const sufficient = firstSeenAt.getTime() <= from && runStart >= nowMs - WINDOW_MS;
    if (sufficient) {
      const prior = minInRange(ev, from, runStart);
      if (prior !== null) {
        reference = prior.price;
        referenceRunStart = runFirst.validFrom;
        referenceEvidenceIds = runFirst.id === undefined ? prior.ids : [...prior.ids, runFirst.id];
      }
    }
  }

  return {
    currentPrice: current.priceMinor,
    low30d: low?.price ?? null,
    low30dFrom: low?.at ?? null,
    firstSeenAt,
    launchPrice,
    lastIncreaseAt,
    isLowest30d,
    reference,
    referenceRunStart,
    referenceEvidenceIds,
  };
};
