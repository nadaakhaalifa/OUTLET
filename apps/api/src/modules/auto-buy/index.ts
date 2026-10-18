/**
 * Public surface of the auto-buy module (A2.3). Other code imports only this file.
 * Ports owned by other modules are listed in `domain/ports.ts`; production binds Unconfigured
 * adapters for every external provider and the merchant-initiated charge stays behind
 * `kill.auto_buy.charge` (off) until VR-P3-01 and VR-P3-02 are Verified (ADR-0036).
 */
export { AutoBuyModule, MissingAutoBuyPortsError, type AutoBuyModuleOptions } from "./auto-buy.module";
export * from "./adapters/tokens";
export {
  FakeAutoBuyFlags,
  FakeBudgetGate,
  FakeCardVault,
  FakeCatalogQuote,
  FakeDeliverability,
  FakeInventoryHold,
  FakeMemberEligibility,
  FakeMitCheckout,
  FakeNotices,
  FakeRisk,
  InMemoryAutoBuyStore,
  RecordingOpsAudit,
} from "./adapters/in-memory";
export { KyselyAutoBuyStore, type AutoBuyDb } from "./adapters/kysely-store";
export type { HandlePriceChange, HandlePriceChangeResult } from "./application/evaluate";
export type { RunAutoBuySweep, ScaCompletionResult, SweepResult } from "./application/sweep";
export type { ManualReviewQueue, ManualReviewResolution, ResolveInput, ResolveResult } from "./application/ops";
export type { CloseOnPurchase, CancelAllForUser } from "./application/lifecycle";
export { PriceChangedSchema } from "./application/evaluate";
export { AutoBuyEventConsumer, AUTO_BUY_CONSUMED_EVENTS, type AutoBuyInboundEvent, type AutoBuyEventResult } from "./application/events";
export type {
  AutoBuyDomainEvent,
  AutoBuyFlagsPort,
  AutoBuyStore,
  BudgetGatePort,
  CardVaultPort,
  CatalogQuotePort,
  DeliverabilityPort,
  InventoryHoldPort,
  MemberEligibilityPort,
  MitCheckoutPort,
  MitLookup,
  MitRequest,
  MitResult,
  Notice,
  NoticePort,
  OpsAuditPort,
  RiskPort,
  SkuQuote,
} from "./domain/ports";
