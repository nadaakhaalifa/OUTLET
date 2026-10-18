/** Public surface of the cart module (A2.3). Other code imports only this file. */
export { CartModule, MissingCartPortsError, type CartModuleOverrides } from "./cart.module";
export {
  CART_CATALOG,
  CART_EVENTS,
  CART_MEMBERSHIP,
  CART_PLATFORM_CONFIG,
  CART_REPOSITORY,
  QUOTE_BAG_FOR_CHECKOUT,
} from "./adapters/tokens";
export { FakeCatalog, storeSummary } from "./adapters/fake-catalog";
export {
  InMemoryCartEventPublisher,
  InMemoryCartRepository,
  StaticMembership,
  StaticPlatformConfig,
} from "./adapters/in-memory";
export type { BagGroupView, BagLineView, BagView, GetCart, QuoteBagForCheckout } from "./application/bag";
export { GET_CART } from "./adapters/tokens";
export { CatalogUnavailableError } from "./domain/ports";
export { cartWire } from "./adapters/wire";
export type {
  CartEventPublisher,
  CartLineRecord,
  CartRecord,
  LineSource,
  CartRepository,
  CatalogPort,
  MembershipPort,
  PlatformConfigPort,
  SkuFacts,
  StoreFacts,
  SuggestionFacts,
} from "./domain/ports";
export { KyselyCartRepository, type CartDb } from "./adapters/kysely-store";
