/**
 * Kill-switch registry (master prompt A2 rule 12, BUILD-PROMPT section 8).
 * Semantics: enabled=true (or no row) means the feature is ALLOWED; a row with enabled=false KILLS it.
 * failMode applies only when the flag store is unreachable and no fresh-enough cache exists:
 *   closed = treat as killed (money paths must never run on unknown state)
 *   open   = treat as allowed (non-money UI features keep working)
 */
export type KillClass = "money" | "ui";
export interface KillSwitchDef {
  readonly class: KillClass;
  readonly failMode: "closed" | "open";
  readonly description: string;
}

const money = (description: string): KillSwitchDef => ({ class: "money", failMode: "closed", description });
const ui = (description: string): KillSwitchDef => ({ class: "ui", failMode: "open", description });

export const KILL_SWITCHES = {
  "payments.card.enabled": money("Card / 3-DS payments"),
  "payments.apple_pay.enabled": money("Apple Pay"),
  "payments.meeza.enabled": money("Meeza"),
  "payments.mobile_wallet.enabled": money("Mobile wallets (Vodafone Cash etc.)"),
  "payments.instapay.enabled": money("InstaPay"),
  "payments.fawry.enabled": money("Fawry reference code"),
  "payments.bnpl.enabled": money("BNPL / installments"),
  "payments.cod.enabled": money("Cash on delivery"),
  "payments.store_credit.enabled": money("Store credit tender"),
  "referrals.payouts.enabled": money("Referral and creator payouts"),
  "gift_cards.sales.enabled": money("Gift-card sales"),
  "pricing.price_watch.enabled": money("Price Watch verified-discount display (off = plain prices everywhere)"),
  "drops.enabled": ui("Drops and the waiting room"),
  "games.enabled": ui("Light games (spin, scratch)"),
  "stylist.llm.enabled": ui("Stylist LLM features"),
  "ranking.ml.enabled": ui("ML ranking (falls back to popularity)"),
  "crawlers.enabled": ui("Price-integrity crawlers"),
  "shipping.international.enabled": ui("International shipping"),
} as const satisfies Record<string, KillSwitchDef>;

export type KillSwitchName = keyof typeof KILL_SWITCHES;

export const isKillSwitchName = (name: string): name is KillSwitchName => Object.hasOwn(KILL_SWITCHES, name);

/** Thrown when targeting rules are written for a kill switch: a partial rollout of a kill is ambiguous. */
export class KillSwitchRulesError extends Error {
  readonly code = "KILL_SWITCH_RULES_FORBIDDEN";
  constructor(readonly key: string) {
    super(`kill switch ${key} is global on/off; rules (rollout, store lists) are not allowed`);
    this.name = "KillSwitchRulesError";
  }
}

/** Rejects non-empty rules for kill-switch keys. Applied in the service and in every store's write path. */
export const assertNoKillSwitchRules = (key: string, rules: object | undefined): void => {
  if (isKillSwitchName(key) && rules !== undefined && Object.keys(rules).length > 0) throw new KillSwitchRulesError(key);
};
