import type { SellerInventoryService } from "./seller-inventory-service.js";

export interface SellerInventoryServices {
  readonly inventory: Pick<SellerInventoryService, "list" | "adjust">;
}
