/** Public surface of the drops module. Other code imports only this file (A2.3). */
export { DropsModule, MissingDropsPortsError, type DropsModuleOptions } from "./drops.module";
export * from "./adapters/tokens";
export {
  FakeDropSwitches,
  FakeSocialSignals,
  InMemoryDropInventory,
  InMemoryDropStore,
  InMemorySoldOutFlags,
} from "./adapters/in-memory";
export { KyselyDropStore, type DropDb } from "./adapters/kysely-store";
export { DropGate, type GateDropView } from "./adapters/gate";
export { AdvanceDrops, type AdvanceReport } from "./application/advance";
export { ClaimDropUnits, ReleaseDropUnits, ReserveDropUnits, unitPrice, type ReserveInput, type ReserveOutcome, type ReservedLine } from "./application/purchase";
export { DEFAULT_DROPS_CONFIG, type DropsConfig, type DropDeps } from "./application/shared";
export type {
  AdmissionVerifierPort,
  DropInventoryPort,
  DropOutboxEvent,
  DropStore,
  PurchaseRecord,
  SocialSignalsPort,
  SoldOutFlagPort,
  SwitchKey,
  SwitchPort,
  UnitsSnapshot,
} from "./domain/ports";
