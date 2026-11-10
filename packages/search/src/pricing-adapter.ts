import { PriceSnapshotService } from "@outlet/pricing-integrity";
import type { Env } from "@outlet/pricing-integrity";
import type { PriceDisplay, PriceDisplayLookup } from "./ports.js";

/** Display decisions come from the pricing-integrity public API only: never computed here. Plain on any doubt. */
export const pricingDisplayLookup = (env: Env): PriceDisplayLookup => {
  const svc = new PriceSnapshotService(env);
  return {
    async forSku(skuId: string): Promise<PriceDisplay> {
      const s = await svc.snapshotForOrderLine(skuId);
      return { verifiedDiscount: s.claimType === "verified_discount", lowest30d: s.claimType === "lowest_30d" };
    },
  };
};
