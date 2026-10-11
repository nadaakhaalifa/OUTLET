import { addCivilDays, cairoLocal, cairoToUtc, MS_PER_HOUR, requireInt } from "./cairo";

/** Weekly payout cycle in the Africa/Cairo calendar (spec T4: weekly cycle). */
export interface CycleConfig {
  /** 0 = Sunday ... 6 = Saturday. Egypt's weekend is Friday and Saturday, so Sunday is a working day. */
  readonly weekday: number;
  readonly hour: number;
}

export const DEFAULT_CYCLE_CONFIG: CycleConfig = { weekday: 0, hour: 10 };

export interface PayoutCycle {
  /** Cairo civil date of the run, `YYYY-MM-DD`. Stable and unique per week. */
  readonly key: string;
  readonly runAtMs: number;
  /** Inclusive upper bound for eligibility: items must be payable at this instant. */
  readonly cutoffMs: number;
}

function validate(cfg: CycleConfig): void {
  requireInt("weekday", cfg.weekday, 0, 6);
  requireInt("hour", cfg.hour, 0, 23);
}

function runOn(y: number, m: number, d: number, cfg: CycleConfig): number {
  return cairoToUtc(y, m, d, cfg.hour * MS_PER_HOUR);
}

/** The most recent cycle whose run instant is at or before `nowMs`. */
export function latestCycle(nowMs: number, cfg: CycleConfig = DEFAULT_CYCLE_CONFIG): PayoutCycle {
  validate(cfg);
  const now = cairoLocal(nowMs);
  for (let back = 0; back <= 7; back += 1) {
    const day = addCivilDays(now.y, now.m, now.d, -back);
    if (new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay() !== cfg.weekday) continue;
    const runAtMs = runOn(day.y, day.m, day.d, cfg);
    if (runAtMs <= nowMs) {
      const key = `${String(day.y).padStart(4, "0")}-${String(day.m).padStart(2, "0")}-${String(day.d).padStart(2, "0")}`;
      return { key, runAtMs, cutoffMs: runAtMs };
    }
  }
  /* c8 ignore next: a weekday always recurs within 7 days and one of the 8 candidates is <= now */
  throw new Error("unreachable: no cycle found within 8 days");
}

/** The first cycle run strictly after `nowMs`. */
export function nextCycleRun(nowMs: number, cfg: CycleConfig = DEFAULT_CYCLE_CONFIG): number {
  validate(cfg);
  const now = cairoLocal(nowMs);
  for (let ahead = 0; ahead <= 7; ahead += 1) {
    const day = addCivilDays(now.y, now.m, now.d, ahead);
    if (new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay() !== cfg.weekday) continue;
    const runAtMs = runOn(day.y, day.m, day.d, cfg);
    if (runAtMs > nowMs) return runAtMs;
  }
  /* c8 ignore next */
  throw new Error("unreachable: no next cycle found within 8 days");
}
