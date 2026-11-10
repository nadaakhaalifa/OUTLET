import { context, propagation } from "@opentelemetry/api";

const KEY = "market_id";

/** Runs fn with market_id in OTel baggage; it propagates over W3C `baggage` headers. */
export const withMarket = <T>(marketId: string, fn: () => T): T => {
  const bag = (propagation.getBaggage(context.active()) ?? propagation.createBaggage()).setEntry(KEY, { value: marketId });
  return context.with(propagation.setBaggage(context.active(), bag), fn);
};

export const getMarketId = (): string | undefined => propagation.getBaggage(context.active())?.getEntry(KEY)?.value;
