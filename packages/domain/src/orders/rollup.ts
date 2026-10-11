import {
  orderGroupMachine,
  type OrderGroupEvent,
  type OrderGroupState,
  type SellerOrderState,
} from "../state-machine";

const DEAD: ReadonlySet<SellerOrderState> = new Set(["CANCELLED", "REJECTED_BY_SELLER"]);
/** Any state at or beyond acceptance that is not a dead end. */
const STARTED: ReadonlySet<SellerOrderState> = new Set([
  "ACCEPTED",
  "PACKED",
  "SHIPPED",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "CLOSED",
]);

export interface GroupRollup {
  readonly event: OrderGroupEvent;
  readonly to: OrderGroupState;
}

/**
 * Pure group roll-up after a seller order changed. Returns the group event to apply, or null when
 * the group stays as it is. The group is never edited by hand (data-model orders, Rules).
 *  - every seller order cancelled or rejected: ALL_SELLER_ORDERS_CANCELLED
 *  - first started seller order of a PAID/CONFIRMED_COD group: FULFILMENT_STARTED
 * COMPLETED is driven by delivery and returns in later waves and is not decided here.
 */
export function rollupOrderGroup(group: OrderGroupState, siblings: readonly SellerOrderState[]): GroupRollup | null {
  if (siblings.length === 0) return null;
  const pick = (event: OrderGroupEvent): GroupRollup | null =>
    orderGroupMachine.can(group, event, { stockAvailable: false })
      ? { event, to: orderGroupMachine.transition(group, event, { stockAvailable: false }) }
      : null;
  if (siblings.every((s) => DEAD.has(s))) return pick("ALL_SELLER_ORDERS_CANCELLED");
  if (siblings.some((s) => STARTED.has(s))) return pick("FULFILMENT_STARTED");
  return null;
}
