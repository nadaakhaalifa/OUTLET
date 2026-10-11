import { defineMachine, guard } from "../machine";

export const GIFT_CARD_STATES = [
  "CREATED",
  "PENDING_PAYMENT",
  "POT_OPEN",
  "ISSUED",
  "DELIVERED",
  "REDEEMED",
  "EXPIRED",
  "VOIDED",
  "CANCELLED",
] as const;
export type GiftCardState = (typeof GIFT_CARD_STATES)[number];

export const GIFT_CARD_EVENTS = [
  "START_CHECKOUT",
  "OPEN_POT",
  "PAYMENT_SUCCEEDED",
  "PAYMENT_FAILED",
  "CLOSE_POT",
  "CANCEL_POT",
  "DELIVER",
  "REDEEM",
  "EXPIRE",
  "VOID",
] as const;
export type GiftCardEvent = (typeof GIFT_CARD_EVENTS)[number];

export interface GiftCardContext {
  /** Group gift: contributions reached the target when the pot closed. */
  readonly potFunded: boolean;
  /** The expiry instant has passed (computed by the caller from an injected clock). */
  readonly expiryReached: boolean;
}

const funded = guard<GiftCardContext>("potFunded", (c) => c.potFunded);
const expired = guard<GiftCardContext>("expiryReached", (c) => c.expiryReached);
const notExpired = guard<GiftCardContext>("expiryNotReached", (c) => !c.expiryReached);

export const giftCardMachine = defineMachine<GiftCardState, GiftCardEvent, GiftCardContext>({
  name: "GiftCard",
  states: GIFT_CARD_STATES,
  events: GIFT_CARD_EVENTS,
  initial: "CREATED",
  terminal: ["REDEEMED", "EXPIRED", "VOIDED", "CANCELLED"],
  transitions: {
    CREATED: { START_CHECKOUT: { to: "PENDING_PAYMENT" }, OPEN_POT: { to: "POT_OPEN" } },
    PENDING_PAYMENT: {
      PAYMENT_SUCCEEDED: { to: "ISSUED" },
      PAYMENT_FAILED: { to: "CANCELLED" },
    },
    POT_OPEN: {
      CLOSE_POT: { to: "ISSUED", guard: funded },
      CANCEL_POT: { to: "CANCELLED" },
    },
    ISSUED: {
      DELIVER: { to: "DELIVERED" },
      REDEEM: { to: "REDEEMED", guard: notExpired },
      EXPIRE: { to: "EXPIRED", guard: expired },
      VOID: { to: "VOIDED" },
    },
    DELIVERED: {
      REDEEM: { to: "REDEEMED", guard: notExpired },
      EXPIRE: { to: "EXPIRED", guard: expired },
      VOID: { to: "VOIDED" },
    },
    REDEEMED: {},
    EXPIRED: {},
    VOIDED: {},
    CANCELLED: {},
  },
});
