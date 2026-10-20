/** Public surface of the channel-odoo module (A2.3). Other code imports only this file. */
export { ChannelOdooModule, MissingOdooPortsError, type ChannelOdooOptions } from "./channel-odoo.module";
export * from "./adapters/tokens";
export { KyselyOdooStore, type OdooDb } from "./adapters/kysely-store";
export { FakeOdooServer, type FakeProduct, type FakeQuant, type FakePricelistItem } from "./adapters/fake-odoo-server";
export {
  FakeOdooDns,
  InMemoryChannelDirectory,
  InMemoryOdooMetrics,
  InMemoryOdooStore,
  InMemorySkuResolver,
  ManualClock,
  RecordingPriceSink,
  RecordingStockSink,
  StaticOdooFlags,
  StaticSecrets,
} from "./adapters/in-memory";
export { ConnectOdooChannel, DisconnectOdooChannel, RunOdooPollBatch, SyncOdooChannel, TestOdooConnection } from "./application/odoo";
export type { PollResult, PollSummary } from "./application/odoo";
export { OdooTransport } from "./application/transport";
export { SECRET_API_KEY, SECRET_LOGIN } from "./domain/ports";
export { JsonVaultOdooSecretReader, MAX_REQUEST_BYTES, OdooEgressRefusedError, ProxiedOdooEgress } from "./adapters/proxied-egress";
export type {
  ChannelDirectoryPort,
  EgressProxyPort,
  EgressProxyPostRequest,
  OdooDnsPort,
  EgressProxyPostResponse,
  OdooSecretFields,
  OdooSecretReaderPort,
  OdooConfig,
  OdooEgressPort,
  OdooErrorCode,
  OdooFlagsPort,
  OdooStore,
  PriceSinkPort,
  ProductLink,
  SecretExistsPort,
  SellerSkuResolverPort,
  StockSinkPort,
} from "./domain/ports";
