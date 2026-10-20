import { useMemo } from "react";

export interface ServerClock {
  /** Server time when the data arrived (fixed; never ticks). */
  readonly atLoadMs: number | null;
  /** Current server time: device time plus the fixed offset, so changing the device clock does not move it. */
  readonly nowFn: () => number;
}

/**
 * A stable server-anchored clock. It does not tick: leaf `Ticker`s call `nowFn` once a second so the
 * screen itself is never re-rendered by the countdown.
 */
export function useServerClock(serverNowAtLoadMs: number | null): ServerClock {
  return useMemo(() => {
    const offset = serverNowAtLoadMs === null ? 0 : serverNowAtLoadMs - Date.now();
    return { atLoadMs: serverNowAtLoadMs, nowFn: () => Date.now() + offset };
  }, [serverNowAtLoadMs]);
}
