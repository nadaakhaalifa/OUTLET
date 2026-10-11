import { subBalanceKey, type StoreCreditSub } from "../chart-of-accounts";
import { InvalidCreditInputError } from "./errors";

export const DAY_MS = 86_400_000;

export type SubKind = StoreCreditSub["kind"];

export interface SubRule {
  readonly kind: SubKind;
  /** Calendar months, or null when the rule is days or never. */
  readonly expiryMonths: number | null;
  readonly expiryDays: number | null;
  /** True when expiry is set per card at issue time (gift_card). */
  readonly perCardExpiry: boolean;
}

/** Spec 15.2 sub-balances and their expiry. Gift-card expiry (default 3 years) comes from the card. */
export const SUB_RULES: Readonly<Record<SubKind, SubRule>> = {
  refund_credit: { kind: "refund_credit", expiryMonths: null, expiryDays: null, perCardExpiry: false },
  gift_card: { kind: "gift_card", expiryMonths: null, expiryDays: null, perCardExpiry: true },
  cashback_coins: { kind: "cashback_coins", expiryMonths: 12, expiryDays: null, perCardExpiry: false },
  referral_credit: { kind: "referral_credit", expiryMonths: 6, expiryDays: null, perCardExpiry: false },
  goodwill: { kind: "goodwill", expiryMonths: null, expiryDays: 90, perCardExpiry: false },
};

/** Kinds that can be written off on expiry by `storeCreditExpired` (platform-funded). */
export const EXPIRING_PLATFORM_KINDS: readonly SubKind[] = ["cashback_coins", "referral_credit", "goodwill"];

/** Adds calendar months in UTC, clamping to the last day of the target month. */
export function addMonthsUtc(ms: number, months: number): number {
  const d = new Date(ms);
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.getTime();
}

/**
 * Expiry instant of a credit lot granted at `grantedAtMs`. For a gift card the card's own expiry
 * is passed. A refund restored to an expiring sub-balance gets the sub's full term again
 * (VERIFY VR-RF-06: whether the original expiry must be preserved).
 */
export function expiryFor(sub: StoreCreditSub, grantedAtMs: number, cardExpiresAtMs?: number | null): number | null {
  const rule = SUB_RULES[sub.kind];
  if (rule.perCardExpiry) {
    if (cardExpiresAtMs === undefined || cardExpiresAtMs === null) {
      throw new InvalidCreditInputError("a gift card lot needs the card's expiry");
    }
    return cardExpiresAtMs;
  }
  if (rule.expiryMonths !== null) return addMonthsUtc(grantedAtMs, rule.expiryMonths);
  if (rule.expiryDays !== null) return grantedAtMs + rule.expiryDays * DAY_MS;
  return null;
}

export function parseSubKey(key: string): StoreCreditSub {
  if (key.startsWith("gift_card:")) {
    const cardId = key.slice("gift_card:".length);
    if (cardId.length === 0) throw new InvalidCreditInputError("gift card sub-balance needs a card id");
    return { kind: "gift_card", cardId };
  }
  switch (key) {
    case "refund_credit":
    case "cashback_coins":
    case "referral_credit":
    case "goodwill":
      return { kind: key };
  }
  throw new InvalidCreditInputError(`unknown sub-balance "${key}"`);
}

export { subBalanceKey };
