export interface SocialProofConfig {
  readonly minBoughtToday: number;
  readonly minViewingNow: number;
  /** Remaining stock is shown only at or below this, and only when real. */
  readonly maxRemainingShown: number;
  readonly refreshMs: number;
}

export const DEFAULT_SOCIAL_PROOF: SocialProofConfig = {
  minBoughtToday: 20,
  minViewingNow: 10,
  maxRemainingShown: 5,
  refreshMs: 60_000,
};

export interface SocialProofInput {
  /** Real events only. null = the signal is unavailable, which shows nothing (never a guess). */
  readonly boughtToday: number | null;
  readonly viewingNow: number | null;
  readonly remaining: number | null;
}

export interface SocialProof {
  readonly boughtToday: number | null;
  readonly viewingNow: number | null;
  readonly remaining: number | null;
}

/** Shows a number only when it is real and above its threshold (CPL 181/2018, spec 16, A2.13). */
export function socialProof(i: SocialProofInput, c: SocialProofConfig = DEFAULT_SOCIAL_PROOF): SocialProof {
  const ok = (n: number | null): n is number => n !== null && Number.isInteger(n) && n >= 0;
  return {
    boughtToday: ok(i.boughtToday) && i.boughtToday >= c.minBoughtToday ? i.boughtToday : null,
    viewingNow: ok(i.viewingNow) && i.viewingNow >= c.minViewingNow ? i.viewingNow : null,
    remaining: ok(i.remaining) && i.remaining >= 1 && i.remaining <= c.maxRemainingShown ? i.remaining : null,
  };
}

export const needsRefresh = (computedAtMs: number | null, nowMs: number, c: SocialProofConfig = DEFAULT_SOCIAL_PROOF): boolean =>
  computedAtMs === null || nowMs - computedAtMs >= c.refreshMs || nowMs < computedAtMs;
