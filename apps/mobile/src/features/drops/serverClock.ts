/**
 * Server-anchored time (spec §16, spec 07 "countdown rings use server time"). The device clock is
 * only used to advance between server readings; the offset is fixed from the server's own timestamp.
 */
export interface ServerClock {
  /** Server `now` minus device `now`, in ms, captured when the server timestamp arrived. */
  readonly offsetMs: number;
}

export function clockFromServer(serverNowMs: number, deviceNowMs: number): ServerClock {
  return { offsetMs: serverNowMs - deviceNowMs };
}

export function serverNow(clock: ServerClock, deviceNowMs: number): number {
  return deviceNowMs + clock.offsetMs;
}

export interface CountdownParts {
  readonly days: number;
  readonly hours: number;
  readonly minutes: number;
  readonly seconds: number;
  readonly done: boolean;
}

/** Floors toward zero; never negative. A finished countdown is `done`, not a negative number. */
export function countdownParts(remainingMs: number): CountdownParts {
  const total = Math.max(0, Math.floor(remainingMs / 1000));
  return {
    days: Math.floor(total / 86_400),
    hours: Math.floor((total % 86_400) / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60,
    done: total === 0,
  };
}
