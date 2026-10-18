import { EG_MARKET } from "./eg";
import { createMarketRegistry } from "./market";

export const DEFAULT_MARKET_CODE = "EG";

/** The production registry: one defined market, one enabled market. */
export const MARKETS = createMarketRegistry([EG_MARKET], {
  defaultCode: DEFAULT_MARKET_CODE,
  enabledCodes: [DEFAULT_MARKET_CODE],
});

/** Release flag that must be true before any non-default market is available (default false). */
export const ADDITIONAL_MARKETS_FLAG = "release.market.additional_markets";
