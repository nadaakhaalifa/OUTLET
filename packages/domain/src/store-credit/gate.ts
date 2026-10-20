import { GiftCardSalesDisabledError } from "./errors";

/** Kill switch for gift-card sales (spec A2.12, ADR-0003). Default OFF. */
export interface GiftCardSalesGate {
  enabled(): boolean;
  assertEnabled(): void;
}

export function giftCardSalesGate(enabled: boolean | undefined): GiftCardSalesGate {
  const on = enabled === true;
  return {
    enabled: () => on,
    assertEnabled: () => {
      if (!on) throw new GiftCardSalesDisabledError("gift card sales are switched off");
    },
  };
}
