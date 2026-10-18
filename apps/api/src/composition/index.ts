/** Composition layer: adapters that join two modules through their public surfaces only. */
export { Late } from "./late";
export { LedgerGateway, type LedgerGatewayDeps, type LedgerUnitOfWork } from "./ledger-gateway";
export {
  CartAdapter,
  DevCommerceTerms,
  InventoryAdapter,
  OrdersAdapter,
  PaymentsModuleProvider,
  PaymentsRegistry,
  PromotionsAdapter,
  StoreCreditAdapter,
  TaxAdapter,
  type CommerceTermsPort,
} from "./checkout-adapters";
export {
  AdminPayoutApprovals,
  LedgerIntegrityPort,
  PaymentEventsToCheckout,
  StoreCreditProjection,
  type BridgeOutcome,
  type BridgedEvent,
} from "./money-adapters";
export { subBalanceStates } from "./credit-balances";
export { composeMoney, createMoneyLates, MoneyBridgeModule, type MoneyLates, type MoneyWiring, type MoneyWiringOptions } from "./money-wiring";
export { Phase3BridgeModule, createPhase3Lates, lazy, type Phase3Lates } from "./phase3-wiring";
export { AddressBookDeliverability, CheckoutCapBudgetGate, LiveSkuQuote, PlusMemberEligibility, type QuoteSources } from "./auto-buy-adapters";
export {
  CatalogSellerSkuResolver,
  CrawlStoreChannelDirectory,
  InventoryStockSink,
  PriceIntegrityPriceSink,
  type SellerSkuLookup,
  type StockSyncUseCase,
} from "./odoo-adapters";
