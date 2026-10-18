/** Public surface of the orders module (A2.3). Other code imports only this file. */
export { OrdersModule, MissingOrdersPortsError, type OrdersModuleOverrides } from "./orders.module";
export { ORDER_COMMANDS, ORDER_DELIVERY_CONSUMER, ORDER_LINE_REFUNDS, ORDER_LINE_RETURNS, ORDER_PLACE, ORDER_REPOSITORY, ORDER_STORE_LOOKUP } from "./adapters/tokens";
export { FakeStoreLookup, InMemoryOrderRepository } from "./adapters/in-memory";
export { KyselyOrderRepository, type OrdersDb } from "./adapters/kysely-store";
export { FakeOrderIntake, type FakeOrderSpec } from "./adapters/fake-intake";
export { OrderCommands, type CommandResult } from "./application/commands";
export { PlaceOrders, type PlaceOrdersInput } from "./application/intake";
export type {
  LineRefundsPort,
  LineReturnsPort,
  SellerReturnWindowPort,
  NewOrderGroup,
  OrderGroupRecord,
  OrderIntake,
  OrderRepository,
  OrderScope,
  SellerOrderRecord,
  StoreLookupPort,
  StoreSummaryFacts,
} from "./domain/ports";
export {
  ORDER_CONSUMED_EVENTS,
  OrderDeliveryConsumer,
  OrderNotYetShippedError,
  type OrderEventResult,
  type OrderInboundEvent,
} from "./application/delivery-events";
