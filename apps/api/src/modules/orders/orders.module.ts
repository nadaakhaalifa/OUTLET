import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import { OrderCommands } from "./application/commands";
import { OrderDeliveryConsumer } from "./application/delivery-events";
import { PlaceOrders } from "./application/intake";
import { GetOrderGroup, GetSellerOrder, ListMyOrders, ListSellerOrders } from "./application/queries";
import { FakeStoreLookup, InMemoryOrderRepository } from "./adapters/in-memory";
import { SellerOrdersController, ShopperOrdersController } from "./adapters/orders.controller";
import { OrderGroupResolver, SellerOrderResolver, ShopperSellerOrderResolver } from "./adapters/resolvers";
import { OrderStoreAccess } from "./adapters/store-access";
import {
  GET_ORDER_GROUP,
  GET_SELLER_ORDER,
  LIST_MY_ORDERS,
  LIST_SELLER_ORDERS,
  ORDERS_NOW,
  ORDER_DELIVERY_CONSUMER,
  ORDER_LINE_REFUNDS,
  ORDER_COMMANDS,
  ORDER_GROUP_RESOLVER,
  ORDER_PLACE,
  ORDER_LINE_RETURNS,
  ORDER_REPOSITORY,
  ORDER_STORE_LOOKUP,
  SELLER_ORDER_RESOLVER,
  SHOPPER_ORDER_RESOLVER,
} from "./adapters/tokens";
import type { LineRefundsPort, LineReturnsPort, OrderRepository, SellerReturnWindowPort, StoreLookupPort } from "./domain/ports";

export interface OrdersModuleOverrides {
  readonly repository?: OrderRepository;
  readonly storeLookup?: StoreLookupPort;
  /** Cumulative refunded goods per line (refunds module). Absent: 0 at closure; see LineRefundsPort. */
  readonly lineRefunds?: LineRefundsPort;
  /**
   * Non-terminal returns per line (returns module), read at closure. Mandatory in the production
   * composition once creators is composed (production/bindings.ts check): absent means every
   * `order_line.closed` states `open_returns: null` and creators defer the accrual.
   */
  readonly lineReturns?: LineReturnsPort;
  /** Seller's own return window (seller-settings), read at closure time (not snapshotted). Absent: statutory 30 days + 3. */
  readonly sellerWindows?: SellerReturnWindowPort;
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
        { provide: ORDER_LINE_REFUNDS, useValue: overrides.lineRefunds ?? null },
        { provide: ORDER_LINE_RETURNS, useValue: overrides.lineReturns ?? null },
        { provide: ORDER_STORE_LOOKUP, useValue: overrides.storeLookup ?? new FakeStoreLookup() },
        { provide: ORDERS_NOW, inject: [CLOCK], useFactory: (c: Clock) => () => c.nowMs() },
        {
          provide: ORDER_COMMANDS,
          inject: [ORDER_REPOSITORY, CLOCK, ID_GENERATOR, ORDER_LINE_REFUNDS, ORDER_LINE_RETURNS],
          useFactory: (
            repo: OrderRepository,
            clock: Clock,
            ids: IdGenerator,
            lineRefunds: LineRefundsPort | null,
            lineReturns: LineReturnsPort | null,
          ) =>
            new OrderCommands({
              repo,
              clock,
              ids,
              ...(lineRefunds === null ? {} : { lineRefunds }),
              ...(lineReturns === null ? {} : { lineReturns }),
              ...(overrides.sellerWindows === undefined ? {} : { sellerWindows: overrides.sellerWindows }),
            }),
        },
        {
          provide: ORDER_DELIVERY_CONSUMER,
          inject: [ORDER_COMMANDS],
          useFactory: (c: OrderCommands) => new OrderDeliveryConsumer(c),
        },
        {
          provide: ORDER_PLACE,
          inject: [ORDER_REPOSITORY, CLOCK],
          useFactory: (repo: OrderRepository, clock: Clock) => new PlaceOrders(repo, clock),
        },
        { provide: GET_ORDER_GROUP, inject: [ORDER_REPOSITORY], useFactory: (r: OrderRepository) => new GetOrderGroup(r) },
        { provide: GET_SELLER_ORDER, inject: [ORDER_REPOSITORY], useFactory: (r: OrderRepository) => new GetSellerOrder(r) },
        { provide: LIST_MY_ORDERS, inject: [ORDER_REPOSITORY], useFactory: (r: OrderRepository) => new ListMyOrders(r) },
        { provide: LIST_SELLER_ORDERS, inject: [ORDER_REPOSITORY], useFactory: (r: OrderRepository) => new ListSellerOrders(r) },
        { provide: ORDER_GROUP_RESOLVER, inject: [ORDER_REPOSITORY], useFactory: (r: OrderRepository) => new OrderGroupResolver(r) },
        { provide: SELLER_ORDER_RESOLVER, inject: [ORDER_REPOSITORY], useFactory: (r: OrderRepository) => new SellerOrderResolver(r) },
        {
          provide: SHOPPER_ORDER_RESOLVER,
          inject: [ORDER_REPOSITORY],
          useFactory: (r: OrderRepository) => new ShopperSellerOrderResolver(r),
        },
      ],
      exports: [ORDER_REPOSITORY, ORDER_LINE_RETURNS, ORDER_COMMANDS, ORDER_DELIVERY_CONSUMER, ORDER_PLACE, ORDER_STORE_LOOKUP],
    };
  }
}
