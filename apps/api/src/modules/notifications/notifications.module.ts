import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import {
  FakeProvider,
  InMemoryAnalytics,
  InMemoryConsentPort,
  InMemoryContactPort,
  InMemoryDeliveryLog,
  InMemoryFrequencyStore,
  InMemoryInboxProcessed,
  InMemoryInboxRepository,
  InMemoryNotificationEvents,
  InMemoryPreferenceRepository,
  InMemoryPushTokenRepository,
  InMemoryRequestRepository,
  InMemorySuppressionRepository,
  InMemoryTemplateRepository,
  StaticProviderRegistry,
} from "./adapters/in-memory";
import { seedTemplates } from "./adapters/seed-templates";
import { NotificationsController } from "./adapters/notifications.controller";
import {
  HANDLE_DOMAIN_EVENT,
  LIST_INBOX,
  MARK_INBOX_READ,
  NOTIFICATION_ANALYTICS,
  NOTIFICATION_CONSENT,
  NOTIFICATION_CONTACTS,
  NOTIFICATION_EVENTS,
  NOTIFICATION_FREQUENCY,
  NOTIFICATION_INBOX_PROCESSED,
  NOTIFICATION_INBOX_REPO,
  NOTIFICATION_LOG,
  NOTIFICATION_PREFERENCES,
  NOTIFICATION_PREFERENCES_REPO,
  NOTIFICATION_PROVIDERS,
  NOTIFICATION_PUSH_TOKENS,
  NOTIFICATION_REQUESTS,
  NOTIFICATION_SUPPRESSIONS,
  NOTIFICATION_TEMPLATES,
  PROCESS_DUE_NOTIFICATIONS,
  REGISTER_PUSH_TOKEN,
  SEND_NOTIFICATION,
} from "./adapters/tokens";
import { HandleDomainEvent } from "./application/handle-domain-event";
import { ListInbox, MarkInboxRead, RegisterPushToken } from "./application/inbox";
import { NotificationPreferences } from "./application/preferences";
import { ProcessDue, SendNotification } from "./application/send-notification";

export interface NotificationsModuleOptions {
  /** Contact returned for users with no explicit entry. Development only; omitted means unknown users are gone. */
  readonly defaultContact?: { readonly locale: "ar" | "en"; readonly phone: string | null; readonly email: string | null };
}

@Module({})
export class NotificationsModule {
  static forRoot(config: AppConfig, options: NotificationsModuleOptions = {}): DynamicModule {
    if (config.adapters !== "in-memory-dev") throw new NoProductionAdaptersError();
    const templates = new InMemoryTemplateRepository();
    const seeding = Promise.all(seedTemplates().map((t) => templates.save(t)));
    void seeding;
    const providers = new StaticProviderRegistry({
      push: [new FakeProvider("expo_push", "push")],
      whatsapp: [new FakeProvider("wa_bsp", "whatsapp")],
      sms: [new FakeProvider("sms_primary", "sms"), new FakeProvider("sms_backup", "sms")],
      email: [new FakeProvider("email_primary", "email")],
    });
    return {
      module: NotificationsModule,
      controllers: [NotificationsController],
      providers: [
        { provide: NOTIFICATION_TEMPLATES, useValue: templates },
        { provide: NOTIFICATION_REQUESTS, useValue: new InMemoryRequestRepository() },
        { provide: NOTIFICATION_LOG, useValue: new InMemoryDeliveryLog() },
        { provide: NOTIFICATION_FREQUENCY, useValue: new InMemoryFrequencyStore() },
        { provide: NOTIFICATION_PREFERENCES_REPO, useValue: new InMemoryPreferenceRepository() },
        { provide: NOTIFICATION_SUPPRESSIONS, useValue: new InMemorySuppressionRepository() },
        { provide: NOTIFICATION_INBOX_REPO, useValue: new InMemoryInboxRepository() },
        { provide: NOTIFICATION_PUSH_TOKENS, useValue: new InMemoryPushTokenRepository() },
        { provide: NOTIFICATION_CONSENT, useValue: new InMemoryConsentPort() },
        {
          provide: NOTIFICATION_CONTACTS,
          useValue: new InMemoryContactPort(options.defaultContact ?? null),
        },
        { provide: NOTIFICATION_PROVIDERS, useValue: providers },
        { provide: NOTIFICATION_EVENTS, useValue: new InMemoryNotificationEvents() },
        { provide: NOTIFICATION_ANALYTICS, useValue: new InMemoryAnalytics() },
        { provide: NOTIFICATION_INBOX_PROCESSED, useValue: new InMemoryInboxProcessed() },
        {
          provide: SEND_NOTIFICATION,
          inject: [
            NOTIFICATION_TEMPLATES, NOTIFICATION_REQUESTS, NOTIFICATION_LOG, NOTIFICATION_FREQUENCY,
            NOTIFICATION_PREFERENCES_REPO, NOTIFICATION_SUPPRESSIONS, NOTIFICATION_INBOX_REPO, NOTIFICATION_PUSH_TOKENS,
            NOTIFICATION_CONSENT, NOTIFICATION_CONTACTS, NOTIFICATION_PROVIDERS, NOTIFICATION_EVENTS,
            NOTIFICATION_ANALYTICS, CLOCK, ID_GENERATOR,
          ],
          useFactory: (
            templatesRepo: InMemoryTemplateRepository,
            requests: InMemoryRequestRepository,
            log: InMemoryDeliveryLog,
            frequency: InMemoryFrequencyStore,
            preferences: InMemoryPreferenceRepository,
            suppressions: InMemorySuppressionRepository,
            inbox: InMemoryInboxRepository,
            tokens: InMemoryPushTokenRepository,
            consent: InMemoryConsentPort,
            contacts: InMemoryContactPort,
            registry: StaticProviderRegistry,
            events: InMemoryNotificationEvents,
            analytics: InMemoryAnalytics,
            clock: Clock,
            ids: IdGenerator,
          ) =>
            new SendNotification({
              templates: templatesRepo, requests, log, frequency, preferences, suppressions, inbox, tokens,
              consent, contacts, providers: registry, events, analytics, clock, ids,
            }),
        },
        {
          provide: PROCESS_DUE_NOTIFICATIONS,
          inject: [NOTIFICATION_REQUESTS, SEND_NOTIFICATION, CLOCK],
          useFactory: (r: InMemoryRequestRepository, s: SendNotification, c: Clock) => new ProcessDue(r, s, c),
        },
        {
          provide: HANDLE_DOMAIN_EVENT,
          inject: [NOTIFICATION_INBOX_PROCESSED, SEND_NOTIFICATION, NOTIFICATION_SUPPRESSIONS],
          useFactory: (p: InMemoryInboxProcessed, s: SendNotification, sup: InMemorySuppressionRepository) =>
            new HandleDomainEvent(p, s, sup),
        },
        {
          provide: NOTIFICATION_PREFERENCES,
          inject: [NOTIFICATION_PREFERENCES_REPO, NOTIFICATION_SUPPRESSIONS, NOTIFICATION_CONSENT, CLOCK],
          useFactory: (
            p: InMemoryPreferenceRepository,
            s: InMemorySuppressionRepository,
            c: InMemoryConsentPort,
            clock: Clock,
          ) => new NotificationPreferences(p, s, c, clock),
        },
        {
          provide: LIST_INBOX,
          inject: [NOTIFICATION_INBOX_REPO, CLOCK],
          useFactory: (i: InMemoryInboxRepository, c: Clock) => new ListInbox(i, c),
        },
        {
          provide: MARK_INBOX_READ,
          inject: [NOTIFICATION_INBOX_REPO, CLOCK],
          useFactory: (i: InMemoryInboxRepository, c: Clock) => new MarkInboxRead(i, c),
        },
        {
          provide: REGISTER_PUSH_TOKEN,
          inject: [NOTIFICATION_PUSH_TOKENS, CLOCK],
          useFactory: (t: InMemoryPushTokenRepository, c: Clock) => new RegisterPushToken(t, c),
        },
      ],
      exports: [SEND_NOTIFICATION, HANDLE_DOMAIN_EVENT, PROCESS_DUE_NOTIFICATIONS],
    };
  }
}
