/**
 * Policy actions per shopper-own resource. Every one of these routes is `self`-scoped (the resource owner is the token subject);
 * @outlet/policy SHOPPER_ACTIONS names them, so a route's action says what it does.
 */
export const ACTIONS = {
  sessionRead: "session.read",
  sessionWrite: "session.revoke",
  passkeyRead: "passkey.manage",
  passkeyWrite: "passkey.manage",
  /** Quote and place both read and consume the caller's bag. */
  checkout: "checkout.place",
  cartRead: "cart.read",
  cartWrite: "cart.write",
  orderRead: "order.read",
  /** Confirming one's own cash-on-delivery order (ownership is enforced by RLS: a foreign id is 404). */
  orderConfirm: "checkout.place",
} as const;
