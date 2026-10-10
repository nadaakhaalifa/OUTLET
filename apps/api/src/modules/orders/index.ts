/** Public surface of the orders module (A2.3). Other code imports only this file. */
export { OrdersModule, MissingOrdersPortsError, type OrdersModuleOverrides } from "./orders.module";
export { ORDER_COMMANDS, ORDER_PLACE, ORDER_REPOSITORY, ORDER_STORE_LOOKUP } from "./adapters/tokens";
export { FakeStoreLookup, InMemoryOrderRepository } from "./adapters/in-memory";
export { KyselyOrderRepository, type OrdersDb } from "./adapters/kysely-store";
export { FakeOrderIntake, type FakeOrderSpec } from "./adapters/fake-intake";
export { OrderCommands, type CommandResult } from "./application/commands";
export { PlaceOrders, type PlaceOrdersInput } from "./application/intake";
export type {
  NewOrderGroup,
  OrderGroupRecord,
  OrderIntake,
  OrderRepository,
  OrderScope,
  SellerOrderRecord,
  StoreLookupPort,
  StoreSummaryFacts,
} from "./domain/ports";
