/** Public surface of the hub-consolidation module. Other code imports only this file (A2.3). */
export {
  HubConsolidationModule,
  MissingHubPortsError,
  type HubConsolidationOptions,
} from "./hub-consolidation.module";
export * from "./adapters/tokens";
export {
  FakeHubLedger,
  FakeOutboundCourier,
  FakeParcelFacts,
  InMemoryHubMetrics,
  InMemoryHubStore,
  StaticHubFlags,
} from "./adapters/in-memory";
export { KyselyHubStore, type HubDb } from "./adapters/kysely-store";
export type {
  DispatchHubParcel,
  EvaluateHubGroup,
  GetHubTracking,
  OpenHubGroup,
  RecordHubReceipt,
  SweepHubGroups,
} from "./application/hub";
export type {
  GroupRecord,
  HubEvent,
  HubFlagsPort,
  HubLedgerPort,
  HubMetrics,
  HubRecord,
  HubStore,
  LegRecord,
  OutboundCourierPort,
  OutboundResult,
  ParcelFacts,
  ParcelFactsPort,
  ParcelRecord,
  ReceiptRecord,
} from "./domain/ports";
