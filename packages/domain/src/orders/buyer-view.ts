import type { SellerOrderState } from "../state-machine";
import { BUYER_ACCESS_GRACE_MS } from "./types";

export interface BuyerContactFacts {
  readonly firstName: string | null;
  readonly phoneRelay: string | null;
  readonly governorateCode: string;
}

export interface BuyerAccessFacts {
  readonly status: SellerOrderState;
  readonly deliveredAtMs: number | null;
  readonly closedAtMs: number | null;
}

export interface SellerBuyerView {
  readonly governorateCode: string;
  readonly firstName?: string;
  readonly phoneRelay?: string;
  readonly addressVisible: boolean;
}

/** States in which the seller needs the buyer's name and relay number to pack and ship. */
const CONTACT_VISIBLE: ReadonlySet<SellerOrderState> = new Set([
  "ACCEPTED",
  "PACKED",
  "SHIPPED",
  "OUT_FOR_DELIVERY",
  "DELIVERY_FAILED",
  "DELIVERED",
  "RETURN_REQUESTED",
  "RETURN_PICKUP_SCHEDULED",
  "RETURN_IN_TRANSIT",
  "RETURN_RECEIVED",
  "RETURN_INSPECTED",
  "DISPUTED",
]);

/** The grant ends 30 days after delivery or return closure (spec B1). Before delivery it is open. */
export function buyerAccessOpen(a: BuyerAccessFacts, nowMs: number): boolean {
  if (!CONTACT_VISIBLE.has(a.status)) return false;
  const anchor = a.closedAtMs ?? a.deliveredAtMs;
  return anchor === null || nowMs < anchor + BUYER_ACCESS_GRACE_MS;
}

/**
 * What a seller may see of the buyer (spec B1, OpenAPI SellerOrderView.buyer). Governorate is always
 * shown (routing, no identification). First name and the relay number appear only while the grant is
 * open. The raw phone number never reaches this function. `addressVisible` says the seller may fetch
 * the delivery address through the fulfilment grant; it is never part of this view.
 */
export function buyerViewForSeller(c: BuyerContactFacts, a: BuyerAccessFacts, nowMs: number): SellerBuyerView {
  if (!buyerAccessOpen(a, nowMs)) return { governorateCode: c.governorateCode, addressVisible: false };
  return {
    governorateCode: c.governorateCode,
    ...(c.firstName !== null ? { firstName: c.firstName } : {}),
    ...(c.phoneRelay !== null ? { phoneRelay: c.phoneRelay } : {}),
    addressVisible: true,
  };
}
