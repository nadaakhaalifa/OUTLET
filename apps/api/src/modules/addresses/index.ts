/** Public surface of the addresses module (A2.3). */
export { AddressesModule, checkoutAddressPort, createAddressService, type AddressesModuleOptions } from "./addresses.module";
export { ADDRESS_SERVICE, ADDRESS_STORE } from "./tokens";
export { InMemoryAddressStore, FixtureCoverage } from "./in-memory";
export { KyselyAddressStore, type AddressDb } from "./kysely-store";
export { AddressService, GIFT_TOKEN_PREFIX, type DeliverySnapshot, type SnapshotOutcome } from "./service";
export { AddressBookCheckoutPort } from "./checkout-port";
export type { AddressStore, AddressView, CoverageSource } from "./ports";
