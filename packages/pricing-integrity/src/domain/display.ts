import { claimAllowed, discountPct } from "./vrp.js";

export type BrandMode = "public" | "member_only" | "hidden";
export type Viewer = "anonymous" | "member";
export type PriceLabel = "verified" | "lowest_30d" | "launch_price" | "plain";
/** Order-line / sku_price_state vocabulary. */
export type ClaimType = "verified_discount" | "lowest_30d" | "launch_price" | "plain";

export interface DisplayInput {
  readonly vrp: bigint | null;
  readonly price: bigint;
  readonly launch: boolean;
  readonly brandMode: BrandMode;
  readonly viewer: Viewer;
  /** Price equals the lowest price of the last 30 days (label only, never a percentage). */
  readonly isLowest30d?: boolean;
}

export interface DisplayDecision {
  readonly showPercent: boolean;
  readonly label: PriceLabel;
  readonly pct?: number;
}

/**
 * What a shopper may see. An unverified claim never shows in any mode (addendum C4); brand mode only narrows.
 * Launch items never show a percentage; hidden never shows one; member_only shows one to members only.
 */
export const displayDecision = (i: DisplayInput): DisplayDecision => {
  if (i.launch) return { showPercent: false, label: "launch_price" };
  const fallback: DisplayDecision = { showPercent: false, label: i.isLowest30d === true ? "lowest_30d" : "plain" };
  if (!claimAllowed(i.vrp, i.price) || i.vrp === null) return fallback;
  if (i.brandMode === "hidden") return fallback;
  if (i.brandMode === "member_only" && i.viewer !== "member") return fallback;
  return { showPercent: true, label: "verified", pct: discountPct(i.vrp, i.price) };
};

/** The claim type recorded on an order line: independent of brand mode (it is the evidence trail, not the display). */
export const claimTypeOf = (i: { vrp: bigint | null; price: bigint; launch: boolean; isLowest30d?: boolean }): ClaimType => {
  if (i.launch) return "launch_price";
  if (claimAllowed(i.vrp, i.price)) return "verified_discount";
  return i.isLowest30d === true ? "lowest_30d" : "plain";
};
