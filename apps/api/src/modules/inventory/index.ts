/** Public surface of the inventory module (A2.3). Other modules import nothing else. */
export { InventoryModule, type InventoryModuleOverrides } from "./inventory.module";
export {
  INVENTORY_CLAIM_RESERVATION,
  INVENTORY_RELEASE_RESERVATION,
  INVENTORY_REPLENISH_POOLS,
  INVENTORY_RESERVE_STOCK,
  INVENTORY_SKU_DIRECTORY,
  INVENTORY_STORE,
  INVENTORY_SWEEP_EXPIRED,
  INVENTORY_TRANSFER_POOLS,
} from "./adapters/tokens";
export type { ReserveStock, ReserveStockResult } from "./application/reserve-stock";
export type { ClaimReservation, ClaimResult, ReleaseReservation, ReleaseResult } from "./application/lifecycle";
export { InMemoryInventoryStore, InMemorySkuDirectory, STANDARD_POOL_ID, FAWRY_POOL_ID } from "./adapters/in-memory";
export { KyselyInventoryStore, LevelBackedSkuDirectory, type InventoryDb } from "./adapters/kysely-store";
export type { InventoryStore, SkuDirectory, SkuLocation } from "./domain/ports";
