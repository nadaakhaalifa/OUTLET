import { addDaysToDateKey, cairoLocalToUtc, cairoParts } from "./cairo";

/** Items must arrive at least this many days before the event (spec P3-02 Rules). */
export const MIN_LEAD_DAYS = 2;

export type Feasibility =
  | { readonly status: "ok"; readonly orderByDateKey: string; readonly guaranteed: false }
  | { readonly status: "may_not_arrive"; readonly orderByDateKey: string; readonly guaranteed: false }
  | { readonly status: "unknown"; readonly orderByDateKey: null; readonly guaranteed: false };

/**
 * Delivery feasibility from the courier p80 transit time (spec 21). The result is an estimate: it
 * never carries a delivery promise (`guaranteed` is the literal false). `p80Days` null means no
 * courier data for this route, which is reported as unknown, never as ok.
 */
export function deliveryFeasibility(input: {
  readonly nowMs: number;
  readonly startsAtMs: number;
  readonly p80Days: number | null;
}): Feasibility {
  if (input.p80Days === null || !Number.isFinite(input.p80Days) || input.p80Days < 0) {
    return { status: "unknown", orderByDateKey: null, guaranteed: false };
  }
  const days = Math.ceil(input.p80Days);
  const eventKey = cairoParts(input.startsAtMs).dateKey;
  const orderByKey = addDaysToDateKey(eventKey, -(days + MIN_LEAD_DAYS));
  // The order-by day ends at 23:59 Cairo on the cutoff date.
  const orderByEnd = cairoLocalToUtc(addDaysToDateKey(orderByKey, 1), 0) - 1;
  if (input.nowMs > orderByEnd) return { status: "may_not_arrive", orderByDateKey: orderByKey, guaranteed: false };
  return { status: "ok", orderByDateKey: orderByKey, guaranteed: false };
}

/** Worst case over several stores: any late store makes the plan late; any unknown without a late store is unknown. */
export function combineFeasibility(parts: readonly Feasibility[]): Feasibility {
  const late = parts.filter((p) => p.status === "may_not_arrive");
  if (late.length > 0) {
    const earliest = late.map((p) => p.orderByDateKey ?? "").sort()[0] ?? "";
    return { status: "may_not_arrive", orderByDateKey: earliest, guaranteed: false };
  }
  if (parts.length === 0 || parts.some((p) => p.status === "unknown")) {
    return { status: "unknown", orderByDateKey: null, guaranteed: false };
  }
  const earliest = parts.map((p) => p.orderByDateKey ?? "").sort()[0] ?? "";
  return { status: "ok", orderByDateKey: earliest, guaranteed: false };
}
