import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import type { Clock, IdGenerator } from "../../platform/ports";
import { CartController } from "./adapters/cart.controller";
import { FakeCatalog } from "./adapters/fake-catalog";
import {
  CartLineResolver,
  InMemoryCartEventPublisher,
  InMemoryCartRepository,
  StaticMembership,
  StaticPlatformConfig,
} from "./adapters/in-memory";
import {
  ADD_LINE,
  CART_CATALOG,
  CART_EVENTS,
  CART_LINE_RESOLVER,
  CART_MEMBERSHIP,
  CART_PLATFORM_CONFIG,
  CART_REPOSITORY,
  GET_CART,
  GET_SUGGESTIONS,
  QUOTE_BAG_FOR_CHECKOUT,
  REMOVE_LINE,
  UPDATE_LINE,
} from "./adapters/tokens";
import {
  AddLine,
  GetCart,
  GetFreeDeliverySuggestions,
  QuoteBagForCheckout,
  RemoveLine,
  UpdateLine,
  type BagDeps,
} from "./application/bag";
import type {
  CartEventPublisher,
  CartRepository,
  CatalogPort,
  MembershipPort,
  PlatformConfigPort,
} from "./domain/ports";

export interface CartModuleOverrides {
  readonly repository?: CartRepository;
  readonly catalog?: CatalogPort;
  readonly membership?: MembershipPort;
  readonly platformConfig?: PlatformConfigPort;
  readonly events?: CartEventPublisher;
}

@Module({})
export class CartModule {
  static forRoot(config: AppConfig, overrides: CartModuleOverrides = {}): DynamicModule {
    if (config.adapters !== "in-memory-dev") throw new NoProductionAdaptersError();
    const repo = overrides.repository ?? new InMemoryCartRepository();
    const deps = {
      inject: [CART_REPOSITORY, CART_CATALOG, CART_MEMBERSHIP, CART_PLATFORM_CONFIG, CART_EVENTS, CLOCK, ID_GENERATOR],
      build: (
        r: CartRepository,
        catalog: CatalogPort,
        membership: MembershipPort,
        platform: PlatformConfigPort,
        events: CartEventPublisher,
        clock: Clock,
        ids: IdGenerator,
      ): BagDeps => ({ repo: r, catalog, membership, platform, events, clock, ids }),
    };
    const useCase = <T>(token: symbol, make: (d: BagDeps) => T) => ({
      provide: token,
      inject: deps.inject,
      useFactory: (...a: Parameters<typeof deps.build>): T => make(deps.build(...a)),
    });
    return {
      module: CartModule,
      controllers: [CartController],
      providers: [
        { provide: CART_REPOSITORY, useValue: repo },
        // DEVELOPMENT FIXTURE: an empty catalog until the catalog module lands (adds answer 422 unknown_sku).
        { provide: CART_CATALOG, useValue: overrides.catalog ?? new FakeCatalog() },
        { provide: CART_MEMBERSHIP, useValue: overrides.membership ?? new StaticMembership() },
        { provide: CART_PLATFORM_CONFIG, useValue: overrides.platformConfig ?? new StaticPlatformConfig() },
        { provide: CART_EVENTS, useValue: overrides.events ?? new InMemoryCartEventPublisher() },
        { provide: CART_LINE_RESOLVER, useValue: new CartLineResolver(repo) },
        useCase(GET_CART, (d) => new GetCart(d)),
        useCase(ADD_LINE, (d) => new AddLine(d)),
        useCase(UPDATE_LINE, (d) => new UpdateLine(d)),
        useCase(REMOVE_LINE, (d) => new RemoveLine(d)),
        useCase(GET_SUGGESTIONS, (d) => new GetFreeDeliverySuggestions(d)),
        useCase(QUOTE_BAG_FOR_CHECKOUT, (d) => new QuoteBagForCheckout(d)),
      ],
      exports: [QUOTE_BAG_FOR_CHECKOUT, CART_CATALOG, CART_MEMBERSHIP, CART_PLATFORM_CONFIG, CART_REPOSITORY, CART_EVENTS],
    };
  }
}
