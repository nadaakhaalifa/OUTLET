/** Public surface of the payments module (A2.3). Other code imports only this file. */
export { PaymentsModule, MissingPaymentsPortsError, type PaymentsModuleOverrides } from "./payments.module";
export {
  PAYMENT_CAPTURE,
  PAYMENT_CREATE_INTENT,
  PAYMENT_EXPIRE_INTENTS,
  PAYMENT_LIST_METHODS,
  PAYMENT_PROCESS_WEBHOOK,
  PAYMENT_PSP_ROUTER,
  PAYMENT_REFUND,
  PAYMENT_STORE,
  PAYMENT_VOID,
} from "./adapters/tokens";
export {
  CapturePayment,
  CreatePaymentIntent,
  ExpirePaymentIntents,
  ListPaymentMethods,
  PAYMENT_WEBHOOK_CONSUMER,
  PaymentIntentNotFoundYet,
  ProcessPaymentWebhook,
  ReceiveWebhook,
  RefundPayment,
  ResolvePendingRefunds,
  VoidPayment,
  type Availability,
  type CreatePaymentIntentCommand,
  type CreatePaymentIntentResult,
  type RefundCommand,
  type RefundResult,
  type SimpleResult,
} from "./application/payments";
export { PspRouter, backoffMs, type PspRouterOptions } from "./application/psp-router";
export { FakePaymentProvider, FAKE_SIGNATURE_HEADER, FAKE_TIMESTAMP_HEADER } from "./adapters/fake-provider";
export { PaymobPort, PAYMOB_PROVIDER_ID, type PaymobConfig } from "./adapters/paymob/port";
export { FixtureTransport } from "./adapters/paymob/fixture-transport";
export type { PaymobTransport } from "./adapters/paymob/transport";
export { FlagPaymentMethodSwitch, StaticPaymentMethodSwitch, type PaymentKillSwitchFlags } from "./adapters/flag-switch";
export { StaticIpAllowList, AllowAllIps } from "./adapters/ip-allowlist";
export { InMemoryPaymentStore } from "./adapters/in-memory-store";
export { KyselyPaymentStore, type PaymentsDb } from "./adapters/kysely-store";
export type {
  CreateIntentRequest,
  CreatedIntent,
  PaymentIntentRecord,
  PaymentMethodSwitchPort,
  PaymentProviderPort,
  PaymentStore,
  ProviderFailure,
  ProviderResult,
  RefundRecord,
  SavedCardRecord,
  WebhookIpAllowListPort,
} from "./domain/ports";
export type { ClientAction } from "./domain/schemas";
