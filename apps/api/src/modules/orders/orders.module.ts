import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import { OrderCommands } from "./application/commands";
import { PlaceOrders } from "./application/intake";
import { GetOrderGroup, GetSellerOrder, ListSellerOrders } from "./application/queries";
import { FakeStoreLookup, InMemoryOrderRepository } from "./adapters/in-memory";
import { SellerOrdersController, ShopperOrdersController } from "./adapters/orders.controller";
import { OrderGroupResolver, SellerOrderResolver, ShopperSellerOrderResolver } from "./adapters/resolvers";
import { OrderStoreAccess } from "./adapters/store-access";
import {
  GET_ORDER_GROUP,
  GET_SELLER_ORDER,
  LIST_SELLER_ORDERS,
  ORDERS_NOW,
  ORDER_COMMANDS,
  ORDER_GROUP_RESOLVER,
  ORDER_PLACE,
  ORDER_REPOSITORY,
  ORDER_STORE_LOOKUP,
  SELLER_ORDER_RESOLVER,
  SHOPPER_ORDER_RESOLVER,
} from "./adapters/tokens";
import type { OrderRepository, StoreLookupPort } from "./domain/ports";

export interface OrdersModuleOverrides {
  readonly repository?: OrderRepository;
  readonly storeLookup?: StoreLookupPort;
}

/** Thrown at boot when a non-test environment has no real store directory for the shopper view. */
export class MissingOrdersPortsError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(
      `OrdersModule requires real ${missing.join(", ")} outside test mode: ` +
        "supply them through OrdersModule.forRoot(config, overrides)",
    );
    this.name = "MissingOrdersPortsError";
  }
}

@Module({})
export class OrdersModule {
  static forRoot(config: AppConfig, overrides: OrdersModuleOverrides = {}): DynamicModule {
    const production = config.adapters !== "in-memory-dev";
    if (production && overrides.repository === undefined) throw new NoProductionAdaptersError();
    if ((production || config.env !== "test") && overrides.storeLookup === undefined) {
      throw new MissingOrdersPortsError(["storeLookup (ORDER_STORE_LOOKUP: store summaries)"]);
    }
    return {
      module: OrdersModule,
      controllers: [ShopperOrdersController, SellerOrdersController],
      providers: [
        OrderStoreAccess,
        {
          provide: ORDER_REPOSITORY,
          inject: [CLOCK, ID_GENERATOR],
          useFactory: (clock: Clock, ids: IdGenerator): OrderRepository =>
            overrides.repository ?? new InMemoryOrderRepository(clock, () => ids.uuidV7()),
        },
        { provide: ORDER_STORE_LOOKUP, useValue: overrides.storeLookup ?? new FakeStoreLookup() },
        { provide: ORDERS_NOW, inject: [CLOCK], useFactory: (c: Clock) => () => c.nowMs() },
        {
          provide: ORDER_COMMANDS,
          inject: [ORDER_REPOSITORY, CLOCK, ID_GENERATOR],
          useFactory: (repo: OrderRepository, clock: Clock, ids: IdGenerator) => new OrderCommands({ repo, clock, ids }),
        },
        {
          provide: ORDER_PLACE,
          inject: [ORDER_REPOSITORY, CLOCK],
          useFactory: (repo: OrderRepository, clock: Clock) => new PlaceOrders(repo, clock),
        },
        { provide: GET_ORDER_GROUP, inject: [ORDER_REPOSITORY], useFactory: (r: OrderRepository) => new GetOrderGroup(r) },
        { provide: GET_SELLER_ORDER, inject: [ORDER_REPOSITORY], useFactory: (r: OrderRepository) => new GetSellerOrder(r) },
        { provide: LIST_SELLER_ORDERS, inject: [ORDER_REPOSITORY], useFactory: (r: OrderRepository) => new ListSellerOrders(r) },
        { provide: ORDER_GROUP_RESOLVER, inject: [ORDER_REPOSITORY], useFactory: (r: OrderRepository) => new OrderGroupResolver(r) },
        { provide: SELLER_ORDER_RESOLVER, inject: [ORDER_REPOSITORY], useFactory: (r: OrderRepository) => new SellerOrderResolver(r) },
        {
          provide: SHOPPER_ORDER_RESOLVER,
          inject: [ORDER_REPOSITORY],
          useFactory: (r: OrderRepository) => new ShopperSellerOrderResolver(r),
        },
      ],
      exports: [ORDER_REPOSITORY, ORDER_COMMANDS, ORDER_PLACE, ORDER_STORE_LOOKUP],
    };
  }
}
