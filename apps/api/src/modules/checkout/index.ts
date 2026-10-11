/** Public surface of the checkout module (A2.3). Other code imports only this file. */
export { CheckoutModule, MissingCheckoutPortsError, type CheckoutModuleOverrides, type CheckoutPorts } from "./checkout.module";
export {
  CHECKOUT_CONTEXT,
  CHECKOUT_PLACE,
  CHECKOUT_QUOTE,
  CHECKOUT_RECOVER,
  CHECKOUT_REPOSITORY,
  CHECKOUT_WEBHOOK,
} from "./adapters/tokens";
export { InMemorySagaRepository } from "./adapters/in-memory";
export { KyselySagaRepository, type CheckoutDb } from "./adapters/kysely-store";
export {
  FakeAddresses,
  FakeAgePolicy,
  FakeAppAttest,
  FakeCart,
  FakeCodConfirmation,
  FakeInventory,
  FakeKillSwitch,
  FakeLedger,
  FakeMetrics,
  FakeOrdersIntake,
  FakePaymentProvider,
  FakePromotions,
  FakeRisk,
  FakeStoreCredit,
  FakeTax,
  StaticPaymentRegistry,
} from "./adapters/fakes";
export { PlaceCheckout, type CommitInput, type CommitResult } from "./application/commit";
export { QuoteCheckout, type QuoteInput, type QuoteResult } from "./application/quote";
export { HandlePaymentWebhook, type WebhookResult } from "./application/payment-events";
export { CancelCheckout, ConfirmCodOrder, GetCheckoutStatus, RecoverSagas } from "./application/lifecycle";
export { SagaHoldLiveness } from "./application/hold-liveness";
export { SagaRunner } from "./application/saga-runner";
export type { CheckoutContext } from "./application/context";
export { LedgerKeyConflictError } from "./domain/ports";
export type {
  BagLine,
  BagSnapshot,
  BagStoreTerms,
  CheckoutMethod,
  ClaimResult,
  ClientAction,
  CreateIntentResult,
  CaptureResult,
  HoldResult,
  PaymentEvent,
  PlaceOrdersCommand,
  ReserveResult,
  TaxQuote,
  WebhookVerification,
  AddressPort,
  AgePolicyPort,
  AppAttestPort,
  CartPort,
  CodConfirmationPort,
  InventoryPort,
  KillSwitchPort,
  LedgerPort,
  MetricsPort,
  OrdersIntakePort,
  PaymentProviderPort,
  PaymentRegistry,
  PromotionsPort,
  RiskPort,
  SagaRecord,
  SagaRepository,
  StoreCreditPort,
  TaxPort,
} from "./domain/ports";
