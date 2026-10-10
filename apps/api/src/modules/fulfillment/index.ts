/** Public surface of the fulfillment module (A2.3). Other code imports only this file. */
export {
  FulfillmentModule,
  MissingFulfillmentPortsError,
  type FulfillmentModuleOverrides,
} from "./fulfillment.module";
export {
  AWB_WORKER,
  DELIVERED_AT_READER,
  FULFILLMENT_COURIERS,
  FULFILLMENT_METRICS,
  FULFILLMENT_ORDERS,
  FULFILLMENT_REPOSITORY,
  FULFILLMENT_SECRETS,
  INGEST_COURIER_WEBHOOK,
} from "./adapters/tokens";
export {
  FakeSellerOrders,
  InMemoryFulfillmentMetrics,
  InMemoryFulfillmentRepository,
  StaticCourierSecrets,
} from "./adapters/in-memory";
export { KyselyFulfillmentRepository, type FulfillmentDb } from "./adapters/kysely-store";
export { FakeBostaCourier } from "./adapters/bosta/fake-bosta";
export { BostaStyleWebhookAdapter, signBostaWebhook } from "./adapters/bosta/bosta-adapter";
export type { AwbWorker } from "./application/awb-worker";
export type { IngestCourierWebhook } from "./application/webhooks";
export {
  CourierRejectedError,
  CourierUnavailableError,
  type AwbRequest,
  type CourierBinding,
  type CourierPort,
  type CourierSecretsPort,
  type CourierWebhookAdapter,
  type DeliveredAtReader,
  type FulfillmentMetrics,
  type FulfillmentRepository,
  type SellerOrderFacts,
  type SellerOrderPort,
  type ShipmentRecord,
} from "./domain/ports";
