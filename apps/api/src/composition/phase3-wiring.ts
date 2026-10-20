import { Inject, Injectable, Module, type DynamicModule, type OnApplicationBootstrap } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { ADDRESS_SERVICE, type AddressService } from "../modules/addresses";
import { CHECKOUT_CAP_GUARD } from "../modules/budget";
import type { CheckoutCapPort } from "../modules/budget";
import { INVENTORY_SYNC_STOCK } from "../modules/inventory";
import { PRICE_INTEGRITY_SERVICE, type PriceIntegrityService } from "../modules/price-integrity";
import { PLUS_ENTITLEMENTS, type PlusEntitlements } from "../modules/subscriptions";
import { Late } from "./late";
import type { StockSyncUseCase } from "./odoo-adapters";

/**
 * Phase 3 cross-module bindings (Odoo channel and auto-buy). Adapters are built before the Nest
 * container exists, so they hold a `Late<T>`; `Phase3BridgeModule` fills each one at bootstrap from
 * the owning module's public provider token. A late that never bound throws on use (fail closed).
 */
export interface Phase3Lates {
  readonly stockSync: Late<StockSyncUseCase>;
  readonly priceIntegrity: Late<PriceIntegrityService>;
  readonly entitlements: Late<PlusEntitlements>;
  readonly addresses: Late<AddressService>;
  readonly capGuard: Late<CheckoutCapPort>;
}

export function createPhase3Lates(): Phase3Lates {
  return {
    stockSync: new Late("inventory.SyncSellerStock"),
    priceIntegrity: new Late("priceIntegrity.Service"),
    entitlements: new Late("subscriptions.PlusEntitlements"),
    addresses: new Late("addresses.AddressService"),
    capGuard: new Late("budget.CheckoutCapGuard"),
  };
}

const LATES = Symbol("phase3.Lates");

const TOKENS: readonly (readonly [keyof Phase3Lates, symbol])[] = [
  ["stockSync", INVENTORY_SYNC_STOCK],
  ["priceIntegrity", PRICE_INTEGRITY_SERVICE],
  ["entitlements", PLUS_ENTITLEMENTS],
  ["addresses", ADDRESS_SERVICE],
  ["capGuard", CHECKOUT_CAP_GUARD],
];

@Injectable()
class Phase3Bridge implements OnApplicationBootstrap {
  constructor(
    @Inject(LATES) private readonly lates: Phase3Lates,
    @Inject(ModuleRef) private readonly ref: ModuleRef,
  ) {}

  onApplicationBootstrap(): void {
    for (const [key, token] of TOKENS) {
      // A module that is not composed in this deployment leaves its late unbound.
      let value: unknown;
      try {
        value = this.ref.get<unknown>(token, { strict: false });
      } catch {
        continue;
      }
      if (value !== null && value !== undefined) (this.lates[key] as Late<unknown>).bind(value);
    }
  }
}

@Module({})
export class Phase3BridgeModule {
  static forRoot(lates: Phase3Lates): DynamicModule {
    return { module: Phase3BridgeModule, providers: [{ provide: LATES, useValue: lates }, Phase3Bridge] };
  }
}

/** A Late<T> as the structural port the adapters expect (resolved at call time). */
export const lazy = <T extends object>(late: Late<T>): T =>
  new Proxy({} as T, {
    get: (_t, prop) => {
      const target = late.get() as Record<string | symbol, unknown>;
      const v = target[prop];
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
