import { cairoDateKey, cairoLocal, MS_PER_HOUR, requireInt } from "../payouts/cairo";

export interface ReconSchedule {
  /** Cairo hour at which the nightly run becomes due. */
  readonly nightlyHour: number;
  /** Minimum gap between intraday runs while mega-event mode is on. */
  readonly intradayEveryMs: number;
}

export const DEFAULT_RECON_SCHEDULE: ReconSchedule = { nightlyHour: 2, intradayEveryMs: 2 * MS_PER_HOUR };

export interface DueRuns {
  readonly nightly: boolean;
  /** The Cairo date the nightly run belongs to. */
  readonly nightlyKey: string;
  readonly intraday: boolean;
}

/**
 * Which runs are due. The nightly run is due once per Cairo date after `nightlyHour`, and again
 * only on the next date. A missed night runs as soon as the job ticks. Intraday runs exist only
 * while `intradayEnabled` (mega-event mode) and are spaced by `intradayEveryMs`.
 */
export function reconciliationDue(input: {
  readonly nowMs: number;
  readonly lastNightlyKey: string | null;
  readonly lastIntradayAtMs: number | null;
  readonly intradayEnabled: boolean;
  readonly schedule?: ReconSchedule;
}): DueRuns {
  const s = input.schedule ?? DEFAULT_RECON_SCHEDULE;
  requireInt("nightlyHour", s.nightlyHour, 0, 23);
  requireInt("intradayEveryMs", s.intradayEveryMs, 60_000, 24 * MS_PER_HOUR);
  const nightlyKey = cairoDateKey(input.nowMs);
  const afterHour = cairoLocal(input.nowMs).msOfDay >= s.nightlyHour * MS_PER_HOUR;
  const nightly = afterHour && input.lastNightlyKey !== nightlyKey;
  const intraday =
    input.intradayEnabled && (input.lastIntradayAtMs === null || input.nowMs - input.lastIntradayAtMs >= s.intradayEveryMs);
  return { nightly, nightlyKey, intraday };
}
