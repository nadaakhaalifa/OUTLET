import type { SellerOrderService } from "./seller-order-service.js";

export interface SellerOrdersServices {
  readonly orders: Pick<SellerOrderService, "list" | "get" | "accept" | "reject" | "pack" | "ship">;
}
