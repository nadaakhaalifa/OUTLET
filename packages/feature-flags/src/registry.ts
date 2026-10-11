/**
 * Typed flag registry. Naming: kill switches are "kill.<area>.<name>" and are boolean where
 * `true` means "the capability is allowed to run". They are DEFAULT-OFF and FAIL CLOSED: an
 * unknown flag, missing provider, provider error, type mismatch or timeout evaluates to false.
 *
 * POLARITY (ADR-0028, "allowed when true"): the word "kill" names the switch, not its value.
 *   true  -> the capability is ALLOWED to run   (operators and the admin console say "Allowed")
 *   false -> the capability is BLOCKED           (operators and the admin console say "Blocked")
 * Never describe a switch as "on" or "off" in UI, runbooks or incident notes; use `describeState`.
 * Inverting the polarity was rejected: default-off would then mean everything is allowed.
 * A rename to `capability.<area>.<name>` (same polarity) is a tracked pre-launch follow-up.
 *
 * A switch that is `false` by default means a fresh environment has everything off until it is
 * explicitly turned on per environment. That is intentional: launching a payment method or
 * payout is a deliberate act (several are legally gated, VERIFY BEFORE LAUNCH).
 *
 * `KILL_SWITCHES` is the A2.12 core set of 14. `PHASE2_KILL_SWITCHES` adds the switches the
 * Phase 2 specs and modules read. Both are registered in `FLAG_REGISTRY`.
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

export const COURIERS = ["bosta", "aramex", "mylerz"] as const;
export type CourierCode = (typeof COURIERS)[number];
export const PLUS_RECURRING_METHODS = ["card", "mobile_wallet", "apple_pay"] as const;
export type PlusRecurringMethod = (typeof PLUS_RECURRING_METHODS)[number];
export const DROP_TYPES = ["public", "members_only", "flash_hour", "mystery_box", "price_ladder", "last_chance"] as const;
export type DropTypeCode = (typeof DROP_TYPES)[number];

/**
 * Phase 2 switches. Polarity is the same as above: `true` allows the capability, `false` (the
 * default) blocks it. The blocked behaviour is stated per entry so operators know the outcome.
 */
export const PHASE2_KILL_SWITCHES = {
  "kill.plus.sales": { description: "Plus sign-ups and plan switches (§14). Blocked: no new subscriptions; existing members keep benefits" },
  "kill.plus.recurring.card": { description: "Plus recurring charges on cards. Blocked: renewals pause and members are told" },
  "kill.plus.recurring.mobile_wallet": { description: "Plus recurring charges on mobile wallets (VERIFY BEFORE LAUNCH). Blocked: renewals pause" },
  "kill.plus.recurring.apple_pay": { description: "Plus recurring charges on Apple Pay. Blocked: renewals pause" },
  "kill.gift_card_redemption": { description: "Gift card redemption into store credit (§15.1). Blocked: redemption answers 503" },
  "kill.rewards_coins": { description: "Earning and converting HAUL Coins (§15.5). Blocked: no new coins, conversions pause" },
  "kill.budget_caps": { description: "Hard and soft spending-cap enforcement at checkout (§12). Blocked: caps are not enforced" },
  "kill.stylist_ml": { description: "ML ranking inside the stylist (§11). Blocked: rule-based outfits (templates, popularity, colour rules)" },
  "kill.llm_search_parse": { description: "LLM natural-language search parsing (§4). Blocked: plain keyword search" },
  "kill.sponsored_products": { description: "Sponsored products and CPC billing (§19). Blocked: no sponsored slots are served or billed" },
  "kill.hub_consolidation": { description: "Hub consolidation of multi-seller orders (§21). Blocked: shipments go out per seller order" },
  "kill.resale_lane": { description: "Returns-resale lane, open-box returned items (§22). Blocked: no new listings or sales" },
  "kill.waiting_room": { description: "Waiting-room queue admission for drops (§16). Blocked: fails closed, drops are paused" },
  "kill.mystery_box": { description: "Mystery-box drops (§16; lottery rules VERIFY BEFORE LAUNCH). Blocked: mystery boxes cannot be created or bought" },
  "kill.drop_type.public": { description: "Public drops (§16). Blocked: this drop type cannot be created or opened" },
  "kill.drop_type.members_only": { description: "Members-only drops (§16). Blocked: this drop type cannot be created or opened" },
  "kill.drop_type.flash_hour": { description: "Flash-hour drops (§16). Blocked: this drop type cannot be created or opened" },
  "kill.drop_type.mystery_box": { description: "Mystery-box drop type (§16). Blocked: this drop type cannot be created or opened" },
  "kill.drop_type.price_ladder": { description: "Price-ladder drops (§16). Blocked: this drop type cannot be created or opened" },
  "kill.drop_type.last_chance": { description: "Last-chance drops (§16). Blocked: this drop type cannot be created or opened" },
  "kill.search_engine": { description: "Typesense as the primary search engine (§4, T9). Blocked: Postgres FTS fallback with reduced features" },
  "kill.courier.bosta": { description: "Bosta courier adapter (§21). Blocked: AWB creation queues and the seller sees label pending" },
  "kill.courier.aramex": { description: "Aramex courier adapter (§21). Blocked: AWB creation queues and the seller sees label pending" },
  "kill.courier.mylerz": { description: "Mylerz courier adapter (§21). Blocked: AWB creation queues and the seller sees label pending" },
} as const;

export const ALL_KILL_SWITCHES = { ...KILL_SWITCHES, ...PHASE2_KILL_SWITCHES } as const;
export type KillSwitchKey = keyof typeof ALL_KILL_SWITCHES;

export const RELEASE_FLAGS = {
  "release.budget_suite": {
    description: "Budget suite and affordability (§12). Blocked: budget routes answer 404 and affordability filters are ignored",
  },
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
  ...(Object.keys(ALL_KILL_SWITCHES) as KillSwitchKey[]).map(
    (key): FlagDefinition => ({
      key,
      kind: "kill_switch",
      description: ALL_KILL_SWITCHES[key].description,
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

export function courierKillSwitch(courier: CourierCode): KillSwitchKey {
  return `kill.courier.${courier}`;
}

export function plusRecurringKillSwitch(method: PlusRecurringMethod): KillSwitchKey {
  return `kill.plus.recurring.${method}`;
}

export function dropTypeKillSwitch(type: DropTypeCode): KillSwitchKey {
  return `kill.drop_type.${type}`;
}

/** What operators and the admin console show for a flag value ("allowed when true", ADR-0028). */
export type FlagState = "allowed" | "blocked";

export function describeFlagState(enabled: boolean): FlagState {
  return enabled ? "allowed" : "blocked";
}

export function isKnownFlag(key: string): key is FlagKey {
  return FLAG_REGISTRY.some((d) => d.key === key);
}
