/** Public surface of the subscriptions (Plus) module. Other code imports only this file (A2.3). */
export { SubscriptionsModule, MissingSubscriptionsPortsError, type SubscriptionsModuleOptions } from "./subscriptions.module";
export * from "./adapters/tokens";
export {
  FakeAgePolicy,
  FakeCardVault,
  FakeFlags,
  FakeLedger,
  FakeNotices,
  FakePersonKeys,
  FakePlanApprovals,
  FakeRecurringCharges,
  FakeRefunds,
  FakeTaxReceipts,
  HmacKeyHasher,
  InMemorySubscriptionStore,
} from "./adapters/in-memory";
export { KyselySubscriptionStore, type PlusDb } from "./adapters/kysely-store";
export type { EntitlementView, PlusEntitlements, RecordBenefitUsed, ReverseBenefit } from "./application/member";
export type { RunRenewalSweep, RecognizeDeferredRevenue, HandleRecurringWebhook } from "./application/sweeper";
export { PLUS_FLAGS } from "./domain/ports";
export type {
  AgePolicyPort,
  CardVaultPort,
  ChargeOutcome,
  ChargeRequest,
  FeatureGatePort,
  KeyHasherPort,
  LedgerPort,
  MemberNoticePort,
  PersonKeyPort,
  PlanPriceApprovalPort,
  PlusEvent,
  PlusRefundPort,
  RecurringChargePort,
  RecurringWebhookEvent,
  RecurringWebhookVerifierPort,
  SubscriptionStore,
  TaxReceiptPort,
} from "./domain/ports";
