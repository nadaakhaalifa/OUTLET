import type { SellerOrderStatus, SellerOrderView } from "../api/schemas";
import type { SellerPermissions } from "../api/schemas-access";

export type OrderAction = "accept" | "reject" | "pack" | "create_shipment";

const WAITING: ReadonlySet<SellerOrderStatus> = new Set(["PAID", "CONFIRMED_COD"]);

/**
 * Order actions need `store_order.update` from the server permissions (never a role name).
 * `null` = not enforced (flag blocked or me unavailable): show by status; the API answers 403 for the rest.
 */
export function availableActions(status: SellerOrderStatus, permissions: SellerPermissions | null): readonly OrderAction[] {
  if (permissions !== null && !permissions["store_order.update"]) return [];
  if (WAITING.has(status)) return ["accept", "reject"];
  if (status === "ACCEPTED") return ["pack"];
  if (status === "PACKED") return ["create_shipment"];
  return [];
}

/** The accept clock only runs while the order is waiting for the seller. */
export function acceptDeadline(o: Pick<SellerOrderView, "status" | "accept_by">): string | null {
  return WAITING.has(o.status) ? o.accept_by : null;
}

export function governorateLabel(code: string | undefined): string | null {
  return code === undefined || code.length === 0 ? null : code;
}

export function isActionable(status: SellerOrderStatus): boolean {
  return WAITING.has(status) || status === "ACCEPTED" || status === "PACKED";
}
