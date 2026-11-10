import type { Queryable } from "@outlet/db";

/** Registry names proposed for @outlet/flags KILL_SWITCHES (both "ui" class, fail open). Not registered here (flags is not ours). */
export const SEARCH_ENGINE_KILL_SWITCH = "search.engine.enabled" as const;
export const SEARCH_FTS_KILL_SWITCH = "search.fts_fallback.enabled" as const;

/**
 * Port over FlagService.isKilled. engine killed = the external engine (Typesense etc., undecided, ADR-0010) is bypassed and the
 * Postgres FTS serves (engineFallback=true). fts killed = search is unavailable (the caller returns a degraded page).
 * A throwing port is treated as "not killed" for both (UI class, fail open).
 */
export interface SearchKillSwitchPort {
  isEngineKilled(): Promise<boolean>;
  isFtsKilled(): Promise<boolean>;
}

export interface PriceDisplay {
  readonly verifiedDiscount: boolean;
  readonly lowest30d: boolean;
}

/** What the shopper may be told about this listing's price. Backed by @outlet/pricing-integrity (fail closed to plain). */
export interface PriceDisplayLookup {
  forSku(skuId: string): Promise<PriceDisplay>;
}

export interface Clock {
  now(): Date;
}

export type { Queryable };
