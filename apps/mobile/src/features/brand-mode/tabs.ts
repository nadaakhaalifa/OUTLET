/** Brand-mode tab specs (pure; the layout renders them). Logical order: the platform mirrors the bar in RTL. */
export type BrandTabId = "dashboard" | "products" | "orders" | "store";
export interface BrandTabSpec {
  readonly route: "index" | "products" | "orders" | "store";
  readonly id: BrandTabId;
  readonly titleKey: `brandMode.tabs.${BrandTabId}`;
  readonly testID: `brand-tab-${BrandTabId}`;
}
export const BRAND_TABS: readonly BrandTabSpec[] = [
  { route: "index", id: "dashboard", titleKey: "brandMode.tabs.dashboard", testID: "brand-tab-dashboard" },
  { route: "products", id: "products", titleKey: "brandMode.tabs.products", testID: "brand-tab-products" },
  { route: "orders", id: "orders", titleKey: "brandMode.tabs.orders", testID: "brand-tab-orders" },
  { route: "store", id: "store", titleKey: "brandMode.tabs.store", testID: "brand-tab-store" },
];
