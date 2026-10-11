/**
 * Public surface of the budget module (A2.3). Other code imports only this file.
 *
 * ISOLATION: promotions, ads, seller-analytics, recommendations and ranking modules must never
 * import this module (spec 12 and 17; enforced by .dependency-cruiser.cjs). Feed, search, stylist
 * and wishlist consume ONLY `AffordabilityFilterPort`, and checkout ONLY `CheckoutCapPort`.
 */
export { BudgetModule, MissingBudgetPortsError, type BudgetModuleOptions } from "./budget.module";
export * from "./adapters/tokens";
export {
  DevAesGcmFieldCipher,
  FakeBagTotal,
  FakeBudgetConsent,
  FakeBudgetFlags,
  FakeOrderSpendSource,
  FakeWishlistPlanSource,
  InMemoryBudgetStore,
} from "./adapters/in-memory";
export { KyselyBudgetStore, type BudgetDb } from "./adapters/kysely-store";
export type {
  AffordabilityFilterPort,
  BagTotalPort,
  BudgetConsentPort,
  BudgetEvent,
  BudgetFlagsPort,
  BudgetStore,
  CheckoutCapPort,
  FieldCipherPort,
  OrderSpendSourcePort,
  WishlistPlanSourcePort,
} from "./domain/ports";
export type { BudgetExport } from "./application/lifecycle";
