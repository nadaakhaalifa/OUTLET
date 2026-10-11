import type { SellerOrderStatus, SellerOrderView, TeamRole } from "../api/schemas";

export type OrderAction = "accept" | "reject" | "pack" | "create_shipment";

/** Roles that may act on orders (UI hint only; the API policy is authoritative and answers 403). */
const FULFILMENT_ROLES: ReadonlySet<TeamRole> = new Set(["owner", "manager", "fulfilment"]);

const WAITING: ReadonlySet<SellerOrderStatus> = new Set(["PAID", "CONFIRMED_COD"]);

export function availableActions(status: SellerOrderStatus, role: TeamRole | null): readonly OrderAction[] {
  // Role unknown (no seller "me" endpoint yet): show by status; the API answers 403 for the rest.
  if (role !== null && !FULFILMENT_ROLES.has(role)) return [];
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
