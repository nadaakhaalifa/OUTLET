/** Public surface of the notifications module. Other code imports only this file (A2.3). */
export { NotificationsModule, type NotificationsModuleOptions, type NotificationsRepositories } from "./notifications.module";
export {
  HANDLE_DOMAIN_EVENT,
  NOTIFICATION_CONSENT,
  NOTIFICATION_CONTACTS,
  NOTIFICATION_PROVIDERS,
  PROCESS_DUE_NOTIFICATIONS,
  SEND_NOTIFICATION,
} from "./adapters/tokens";
export {
  FakeProvider,
  InMemoryConsentPort,
  InMemoryContactPort,
} from "./adapters/in-memory";
export type { HandleDomainEvent, InboundEvent, HandleResult } from "./application/handle-domain-event";
export type { ProcessDue, SendInput, SendNotification, SendResult } from "./application/send-notification";
export type {
  ChannelProvider,
  ConsentPort,
  ContactPort,
  EmailProvider,
  ProviderMessage,
  ProviderRegistry,
  ProviderResult,
  PushProvider,
  SmsProvider,
  WhatsAppProvider,
} from "./domain/ports";
export {
  KyselyDeliveryLogRepository,
  KyselyFrequencyStore,
  KyselyInboxRepository,
  KyselyPreferenceRepository,
  KyselyPushTokenRepository,
  KyselyRequestRepository,
  KyselySuppressionRepository,
  KyselyTemplateRepository,
  type NotificationsDb,
} from "./adapters/kysely-store";
export {
  DroppingAnalytics,
  KyselyInboxProcessed,
  LogNotificationEvents,
  PrivacyConsentPort,
  UnconfiguredChannelProvider,
  unconfiguredProviderRegistry,
} from "./adapters/production-adapters";
export { seedTemplates } from "./adapters/seed-templates";
