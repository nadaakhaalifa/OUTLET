/**
 * Typed flag registry. Naming: kill switches are "kill.<area>.<name>" and are boolean where
 * `true` means "the capability is allowed to run". They are DEFAULT-OFF and FAIL CLOSED: an
 * unknown flag, missing provider, provider error, type mismatch or timeout evaluates to false.
 *
 * A switch that is `false` by default means a fresh environment has everything off until it is
 * explicitly turned on per environment. That is intentional: launching a payment method or
 * payout is a deliberate act (several are legally gated, VERIFY BEFORE LAUNCH).
 */
export const PAYMENT_METHODS = ["card", "apple_pay", "mobile_wallet", "instapay", "fawry"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const KILL_SWITCHES = {
  "kill.payment.card": { description: "Card payments via the PSP" },
  "kill.payment.apple_pay": { description: "Apple Pay" },
  "kill.payment.mobile_wallet": { description: "Mobile wallet payments (e.g. Vodafone Cash)" },
  "kill.payment.instapay": { description: "InstaPay QR / request-to-pay" },
  "kill.payment.fawry": { description: "Fawry reference-code payments" },
  "kill.payment.cod": { description: "Cash on delivery" },
  "kill.payment.bnpl": { description: "Buy now pay later (lender-provided; VERIFY BEFORE LAUNCH)" },
  "kill.drops": { description: "Limited drops and the waiting room" },
  "kill.games": { description: "Games and rewards mechanics" },
  "kill.stylist_llm": { description: "LLM stylist" },
  "kill.ml_ranking": { description: "ML ranking; fall back to rules-based ranking" },
  "kill.crawlers": { description: "External catalogue and price crawlers" },
  "kill.referral_payouts": { description: "Referral reward payouts" },
  "kill.gift_card_sales": { description: "Gift card sales" },
} as const;
export type KillSwitchKey = keyof typeof KILL_SWITCHES;

export const RELEASE_FLAGS = {
  "release.us_storefront_linkout": {
    description: "US-only web purchase link-out (spec section on App Store storefronts); VERIFY BEFORE LAUNCH",
  },
} as const;
export type ReleaseFlagKey = keyof typeof RELEASE_FLAGS;

export type FlagKey = KillSwitchKey | ReleaseFlagKey;

export interface FlagDefinition {
  readonly key: FlagKey;
  readonly kind: "kill_switch" | "release";
  readonly description: string;
  readonly defaultValue: false;
  readonly failClosed: true;
}

export const FLAG_REGISTRY: readonly FlagDefinition[] = [
  ...(Object.keys(KILL_SWITCHES) as KillSwitchKey[]).map(
    (key): FlagDefinition => ({
      key,
      kind: "kill_switch",
      description: KILL_SWITCHES[key].description,
      defaultValue: false,
      failClosed: true,
    }),
  ),
  ...(Object.keys(RELEASE_FLAGS) as ReleaseFlagKey[]).map(
    (key): FlagDefinition => ({
      key,
      kind: "release",
      description: RELEASE_FLAGS[key].description,
      defaultValue: false,
      failClosed: true,
    }),
  ),
];

export function paymentKillSwitch(method: PaymentMethod): KillSwitchKey {
  return `kill.payment.${method}`;
}

export function isKnownFlag(key: string): key is FlagKey {
  return FLAG_REGISTRY.some((d) => d.key === key);
}
