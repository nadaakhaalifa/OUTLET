import type { SellerFinanceService } from "./seller-finance-service.js";

export interface SellerFinanceServices {
  readonly finance: Pick<SellerFinanceService, "balance" | "listPayouts" | "getPayout" | "statement">;
}
