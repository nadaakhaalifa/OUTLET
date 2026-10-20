import { Module, type DynamicModule } from "@nestjs/common";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import type { AppConfig } from "../../config/env";
import { ClaimReservation, ReleaseReservation, ReplenishPools, SweepExpiredReservations } from "./application/lifecycle";
import { ReserveStock } from "./application/reserve-stock";
import { SyncSellerStock } from "./application/sync-stock";
import { TransferBetweenPools } from "./application/transfer-pool";
import type { InventoryStore, SkuDirectory } from "./domain/ports";
import { FAWRY_POOL_ID, InMemoryInventoryStore, InMemorySkuDirectory, STANDARD_POOL_ID } from "./adapters/in-memory";
import { SkuStockResolver } from "./adapters/sku-resolver";
import { StockController } from "./adapters/stock.controller";
import {
  INVENTORY_CLAIM_RESERVATION,
  INVENTORY_RELEASE_RESERVATION,
  INVENTORY_REPLENISH_POOLS,
  INVENTORY_RESERVE_STOCK,
  INVENTORY_SKU_DIRECTORY,
  INVENTORY_SKU_RESOLVER,
  INVENTORY_STORE,
  INVENTORY_SWEEP_EXPIRED,
  INVENTORY_SYNC_STOCK,
  INVENTORY_TRANSFER_POOLS,
} from "./adapters/tokens";

export interface InventoryModuleOverrides {
  /** Tests and the integrator may supply a pre-seeded store and directory (for example the Kysely adapter). */
  readonly store?: InventoryStore;
  readonly directory?: SkuDirectory;
}

@Module({})
export class InventoryModule {
  static forRoot(config: AppConfig, overrides: InventoryModuleOverrides = {}): DynamicModule {
    if (config.adapters !== "in-memory-dev" && overrides.store === undefined) throw new NoProductionAdaptersError();
    const ports = (c: Clock) => ({ nowMs: () => c.nowMs() });
    return {
      module: InventoryModule,
      controllers: [StockController],
      providers: [
        {
          provide: INVENTORY_STORE,
          inject: [ID_GENERATOR],
          useFactory: (ids: IdGenerator): InventoryStore => overrides.store ?? new InMemoryInventoryStore(() => ids.uuidV7()),
        },
        {
          provide: INVENTORY_SKU_DIRECTORY,
          useFactory: (): SkuDirectory => overrides.directory ?? new InMemorySkuDirectory(),
        },
        {
          provide: INVENTORY_RESERVE_STOCK,
          inject: [INVENTORY_STORE, INVENTORY_SKU_DIRECTORY, CLOCK, ID_GENERATOR],
          useFactory: (s: InventoryStore, d: SkuDirectory, c: Clock, ids: IdGenerator) =>
            new ReserveStock(s, d, ports(c), { newId: () => ids.uuidV7() }),
        },
        {
          provide: INVENTORY_CLAIM_RESERVATION,
          inject: [INVENTORY_STORE, CLOCK],
          useFactory: (s: InventoryStore, c: Clock) => new ClaimReservation(s, ports(c)),
        },
        {
          provide: INVENTORY_RELEASE_RESERVATION,
          inject: [INVENTORY_STORE, CLOCK],
          useFactory: (s: InventoryStore, c: Clock) => new ReleaseReservation(s, ports(c)),
        },
        {
          provide: INVENTORY_SWEEP_EXPIRED,
          inject: [INVENTORY_STORE, CLOCK],
          useFactory: (s: InventoryStore, c: Clock) => new SweepExpiredReservations(s, ports(c)),
        },
        {
          provide: INVENTORY_REPLENISH_POOLS,
          inject: [INVENTORY_STORE],
          useFactory: (s: InventoryStore) => new ReplenishPools(s),
        },
        {
          provide: INVENTORY_SYNC_STOCK,
          inject: [INVENTORY_STORE, INVENTORY_SKU_DIRECTORY, CLOCK],
          useFactory: (s: InventoryStore, d: SkuDirectory, c: Clock) =>
            new SyncSellerStock(s, d, ports(c), STANDARD_POOL_ID),
        },
        {
          provide: INVENTORY_TRANSFER_POOLS,
          inject: [INVENTORY_STORE, INVENTORY_SKU_DIRECTORY, CLOCK],
          useFactory: (s: InventoryStore, d: SkuDirectory, c: Clock) =>
            new TransferBetweenPools(s, d, ports(c), { standard: STANDARD_POOL_ID, fawry: FAWRY_POOL_ID }),
        },
        {
          provide: INVENTORY_SKU_RESOLVER,
          inject: [INVENTORY_SKU_DIRECTORY],
          useFactory: (d: SkuDirectory) => new SkuStockResolver(d),
        },
      ],
      exports: [
        INVENTORY_STORE,
        INVENTORY_SKU_DIRECTORY,
        INVENTORY_RESERVE_STOCK,
        INVENTORY_CLAIM_RESERVATION,
        INVENTORY_RELEASE_RESERVATION,
        INVENTORY_SWEEP_EXPIRED,
        INVENTORY_REPLENISH_POOLS,
        INVENTORY_TRANSFER_POOLS,
      ],
    };
  }
}
