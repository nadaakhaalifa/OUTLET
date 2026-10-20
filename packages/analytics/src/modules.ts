/**
 * Owner modules. Names follow ADR-0001's module list where it names one (auth, catalog, inventory,
 * checkout, ledger, payouts, tax-eta, returns); the rest are proposed and must be reconciled with
 * the module map when the backend skeleton lands.
 */
export const OWNER_MODULES = [
  "app-shell",
  "identity",
  "privacy",
  "search",
  "catalog",
  "fit",
  "stylist",
  "budget",
  "bag",
  "checkout",
  "inventory",
  "wishlist",
  "price-integrity",
  "plus",
  "gift-cards",
  "referrals",
  "rewards",
  "drops",
  "returns",
  "refunds",
  "notifications",
  "recommendations",
  "ads",
  "reviews",
] as const;

export type OwnerModule = (typeof OWNER_MODULES)[number];
