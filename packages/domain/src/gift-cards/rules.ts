import { giftCardMachine, type GiftCardEvent, type GiftCardState } from "../state-machine/machines/gift-card";
import { violatesWording } from "../store-credit/wording";

/** Spec 15.1 and B6. Amounts are integer piastres (bigint). */
export const GIFT_CARD_LIMITS = {
  minAmount: 10_000n, // 100 EGP
  maxAmount: 1_000_000n, // 10,000 EGP
  /** Purchases strictly above this need a purchaser aged 21+ (B6 age_policy). */
  age21Above: 500_000n, // 5,000 EGP
  /** A new card paying strictly above this must pass 3-DS. */
  threeDsAbove: 200_000n, // 2,000 EGP
  minContribution: 5_000n, // 50 EGP
  /** Default expiry (spec 15.1). VERIFY BEFORE LAUNCH: VR-09 Egyptian limits on gift-card expiry. */
  expiryYears: 3,
  maxMessageChars: 500,
} as const;

export const GIFT_CARD_DESIGNS = ["birthday", "eid", "ramadan", "wedding", "new_baby", "graduation", "thank_you"] as const;
export type GiftCardDesign = (typeof GIFT_CARD_DESIGNS)[number];

export const DELIVERY_CHANNELS = ["whatsapp", "sms", "email", "in_app"] as const;
export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number];

/** Methods a card may be bought with. Store credit, gift cards, BNPL and COD are refused (laundering loops, B3). */
export const PURCHASE_PAYMENT_METHODS = ["card", "apple_pay", "meeza", "mobile_wallet", "instapay", "fawry"] as const;
export type PurchasePaymentMethod = (typeof PURCHASE_PAYMENT_METHODS)[number];
export const REFUSED_PURCHASE_METHODS = ["store_credit", "gift_card", "bnpl", "cod"] as const;

export const isPurchaseMethod = (m: string): m is PurchasePaymentMethod =>
  (PURCHASE_PAYMENT_METHODS as readonly string[]).includes(m);

export type AmountCheck = { readonly ok: true } | { readonly ok: false; readonly reason: "below_min" | "above_max" | "not_whole_egp" };

/** Whole EGP only: custom amounts are allowed but not fractions of a pound. */
export function checkAmount(amount: bigint): AmountCheck {
  if (amount < GIFT_CARD_LIMITS.minAmount) return { ok: false, reason: "below_min" };
  if (amount > GIFT_CARD_LIMITS.maxAmount) return { ok: false, reason: "above_max" };
  if (amount % 100n !== 0n) return { ok: false, reason: "not_whole_egp" };
  return { ok: true };
}

export const requiredMinimumAge = (amount: bigint): 18 | 21 => (amount > GIFT_CARD_LIMITS.age21Above ? 21 : 18);

export const requiresThreeDs = (amount: bigint, isNewCard: boolean): boolean =>
  isNewCard && amount > GIFT_CARD_LIMITS.threeDsAbove;

/** Calendar expiry, UTC. 29 February rolls to 28 February so the card never expires later than promised. */
export function expiryFrom(issuedAtMs: number, years: number = GIFT_CARD_LIMITS.expiryYears): number {
  const d = new Date(issuedAtMs);
  const y = d.getUTCFullYear() + years;
  const month = d.getUTCMonth();
  const day = d.getUTCDate();
  const lastDay = new Date(Date.UTC(y, month + 1, 0)).getUTCDate();
  return Date.UTC(y, month, Math.min(day, lastDay), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
}

/** What a gift card balance may pay for. Never another gift card, never Plus (spec 15.1). */
export type SpendKind = "merchandise" | "delivery" | "gift_card" | "plus";
export const canSpendCreditOn = (kind: SpendKind): boolean => kind === "merchandise" || kind === "delivery";

export type RedemptionPlan =
  | { readonly ok: true; readonly amount: bigint; readonly remainingAfter: bigint; readonly full: boolean }
  | { readonly ok: false; readonly reason: "nothing_left" | "invalid_amount" | "exceeds_balance" };

/** Partial redemption: `requested = null` takes everything left. Conservation: amount + remainingAfter === remaining. */
export function planRedemption(remaining: bigint, requested: bigint | null): RedemptionPlan {
  if (remaining <= 0n) return { ok: false, reason: "nothing_left" };
  const amount = requested ?? remaining;
  if (amount <= 0n) return { ok: false, reason: "invalid_amount" };
  if (amount > remaining) return { ok: false, reason: "exceeds_balance" };
  return { ok: true, amount, remainingAfter: remaining - amount, full: amount === remaining };
}

export type RedemptionView = "none" | "partial" | "full";
export function redemptionView(face: bigint, remaining: bigint): RedemptionView {
  if (remaining <= 0n) return "full";
  return remaining < face ? "partial" : "none";
}

export interface ExpiryContext {
  readonly nowMs: number;
  readonly expiresAtMs: number | null;
}

/** Machine context: `expiryReached` is computed from an injected clock, never read here. */
export const expiryReached = (c: ExpiryContext): boolean => c.expiresAtMs !== null && c.nowMs >= c.expiresAtMs;

export function canRedeemNow(state: GiftCardState, c: ExpiryContext): boolean {
  return giftCardMachine.can(state, "REDEEM", { potFunded: false, expiryReached: expiryReached(c) });
}

/** A purchaser may void until the card is delivered (spec edge cases) and only from ISSUED. */
export const canVoid = (state: GiftCardState): boolean => state === "ISSUED" && giftCardMachine.can(state, "VOID", { potFunded: false, expiryReached: false });

export function next(state: GiftCardState, event: GiftCardEvent, c: ExpiryContext & { readonly potFunded?: boolean }): GiftCardState {
  return giftCardMachine.transition(state, event, { potFunded: c.potFunded ?? false, expiryReached: expiryReached(c) });
}

/** Free text a user may attach. Closed loop: the product vocabulary never offers cash (ADR-0003, ADR-0018). */
export const COPY_VIOLATES_WORDING = violatesWording;
