import { guestBehaviour, type GuestFeature } from "../guest/capabilities";

export interface GuestStateCopy {
  readonly titleKey: `guestStates.${string}`;
  readonly bodyKey: `guestStates.${string}`;
}

/** Honest copy per guest kind. Orders and returns have their own text (spec section 2); nothing here offers an account. */
export function guestStateCopy(feature: GuestFeature): GuestStateCopy {
  if (feature === "orders") return { titleKey: "guestStates.ordersTitle", bodyKey: "guestStates.ordersBody" };
  if (feature === "returns") return { titleKey: "guestStates.returnsTitle", bodyKey: "guestStates.returnsBody" };
  return guestBehaviour(feature) === "deferred"
    ? { titleKey: "guestStates.deferredTitle", bodyKey: "guestStates.deferredBody" }
    : { titleKey: "guestStates.unavailableTitle", bodyKey: "guestStates.unavailableBody" };
}
