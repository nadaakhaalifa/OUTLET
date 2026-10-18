import { cairoLocalToUtc, cairoParts } from "@outlet/domain";

/**
 * The only way a request becomes a window for a shopper-gated read (spec "One window function", ADR-0052 decision 4).
 * Cairo calendar months only; a month is released once `now >= month_end + settleHours`. Pure: the clock is an input.
 */
export const MIN_SETTLE_HOURS = 24;
export const DEFAULT_SETTLE_HOURS = 48;
const MAX_RANGE_MONTHS = 12;

export type GatedRequest = { readonly preset: string } | { readonly from: string; readonly to: string };
export interface GatedWindow {
  /** Complete Cairo months (`YYYY-MM`), oldest first, that are settled and may be released. */
  readonly months: readonly string[];
  /** Months of the window not yet settled (not released). */
  readonly unsettled: readonly string[];
}
export type GatedWindowResult = { readonly ok: true; readonly window: GatedWindow } | { readonly ok: false; readonly error: "invalid_window" | "window_not_on_grid" | "window_too_large" };

const key = (y: number, m: number): string => `${y}-${String(m).padStart(2, "0")}`;
const shift = (y: number, m: number, by: number): [number, number] => {
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return [d.getUTCFullYear(), d.getUTCMonth() + 1];
};
const monthEndMs = (y: number, m: number): number => {
  const [ny, nm] = shift(y, m, 1);
  return cairoLocalToUtc(ny, nm, 1, 0, 0);
};

export function gatedWindow(request: GatedRequest, nowMs: number, settleHours: number = DEFAULT_SETTLE_HOURS): GatedWindowResult {
  if (!Number.isFinite(settleHours) || settleHours < MIN_SETTLE_HOURS) throw new RangeError(`settleHours must be >= ${MIN_SETTLE_HOURS}`);
  const now = cairoParts(nowMs);
  let list: [number, number][] = [];
  if ("preset" in request) {
    const p = request.preset;
    const month = /^month:(\d{4})-(0[1-9]|1[0-2])$/.exec(p);
    const last = /^last_full_months:(1|3|6|12)$/.exec(p);
    if (month !== null) list = [[Number(month[1]), Number(month[2])]];
    else if (last !== null) {
      const n = Number(last[1]);
      for (let i = n; i >= 1; i--) list.push(shift(now.year, now.month, -i));
    } else if (p === "current_month") list = [];
    else return { ok: false, error: "window_not_on_grid" };
  } else {
    const from = Date.parse(request.from);
    const to = Date.parse(request.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return { ok: false, error: "invalid_window" };
    const a = cairoParts(from);
    const b = cairoParts(to - 1);
    // Custom ranges are accepted only when they are exactly whole Cairo months (spec: no arbitrary from/to on the gated grid).
    if (from !== cairoLocalToUtc(a.year, a.month, 1, 0, 0) || to !== monthEndMs(b.year, b.month)) return { ok: false, error: "window_not_on_grid" };
    let [y, m] = [a.year, a.month];
    while (y < b.year || (y === b.year && m <= b.month)) {
      list.push([y, m]);
      if (list.length > MAX_RANGE_MONTHS) return { ok: false, error: "window_too_large" };
      [y, m] = shift(y, m, 1);
    }
  }
  const settleMs = settleHours * 3_600_000;
  const months: string[] = [];
  const unsettled: string[] = [];
  for (const [y, m] of list) (nowMs >= monthEndMs(y, m) + settleMs ? months : unsettled).push(key(y, m));
  return { ok: true, window: { months, unsettled } };
}
