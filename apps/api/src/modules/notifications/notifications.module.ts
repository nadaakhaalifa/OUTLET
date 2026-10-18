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
import type {
  AnalyticsPort,
  ConsentPort,
  ContactPort,
  DeliveryLogRepository,
  InboxProcessedPort,
  NotificationEventPublisher,
  ProviderRegistry,
  FrequencyStore,
  InboxRepository,
  PreferenceRepository,
  PushTokenRepository,
  RequestRepository,
  SuppressionRepository,
  TemplateRepository,
} from "./domain/ports";
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

const failClosed = (): ProviderRegistry => {
  throw new NoProductionAdaptersError();
};

export interface NotificationsRepositories {
  readonly templates: TemplateRepository;
  readonly requests: RequestRepository;
  readonly log: DeliveryLogRepository;
  readonly frequency: FrequencyStore;
  readonly preferences: PreferenceRepository;
  readonly suppressions: SuppressionRepository;
  readonly inbox: InboxRepository;
  readonly pushTokens: PushTokenRepository;
}

export interface NotificationsModuleOptions {
  /** Postgres repositories (KyselyNotifications*). Omitted means the in-memory fixtures. */
  readonly repositories?: NotificationsRepositories;
  /**
   * Required when config.adapters is "production": consent (privacy), contacts, providers
   * (Unconfigured adapters that fail at call time), events, analytics and inbox dedupe.
   * There is no default, so a production boot cannot get a FakeProvider.
   */
  readonly production?: {
    readonly consent: ConsentPort;
    readonly contacts: ContactPort;
    readonly providers: ProviderRegistry;
    readonly events: NotificationEventPublisher;
    readonly analytics: AnalyticsPort;
    readonly inboxProcessed: InboxProcessedPort;
  };
  /** Contact returned for users with no explicit entry. Development only; omitted means unknown users are gone. */
  readonly defaultContact?: { readonly locale: "ar" | "en"; readonly phone: string | null; readonly email: string | null };
}

@Module({})
export class NotificationsModule {
  static forRoot(config: AppConfig, options: NotificationsModuleOptions = {}): DynamicModule {
    const prod = options.production;
    const devMode = config.adapters === "in-memory-dev";
    if (!devMode && (prod === undefined || options.repositories === undefined)) throw new NoProductionAdaptersError();
    const r = options.repositories;
    const templates: TemplateRepository = r?.templates ?? new InMemoryTemplateRepository();
    if (r === undefined && devMode) void Promise.all(seedTemplates().map((t) => templates.save(t)));
    // FakeProvider is built only on the dev branch; production uses `prod.providers` and nothing else.
    const providers: ProviderRegistry = prod?.providers ?? (!devMode ? failClosed() : new StaticProviderRegistry({
      push: [new FakeProvider("expo_push", "push")],
      whatsapp: [new FakeProvider("wa_bsp", "whatsapp")],
      sms: [new FakeProvider("sms_primary", "sms"), new FakeProvider("sms_backup", "sms")],
      email: [new FakeProvider("email_primary", "email")],
    }));
    return {
      module: NotificationsModule,
      controllers: [NotificationsController],
      providers: [
        { provide: NOTIFICATION_TEMPLATES, useValue: templates },
        { provide: NOTIFICATION_REQUESTS, useValue: r?.requests ?? new InMemoryRequestRepository() },
        { provide: NOTIFICATION_LOG, useValue: r?.log ?? new InMemoryDeliveryLog() },
        { provide: NOTIFICATION_FREQUENCY, useValue: r?.frequency ?? new InMemoryFrequencyStore() },
        { provide: NOTIFICATION_PREFERENCES_REPO, useValue: r?.preferences ?? new InMemoryPreferenceRepository() },
        { provide: NOTIFICATION_SUPPRESSIONS, useValue: r?.suppressions ?? new InMemorySuppressionRepository() },
        { provide: NOTIFICATION_INBOX_REPO, useValue: r?.inbox ?? new InMemoryInboxRepository() },
        { provide: NOTIFICATION_PUSH_TOKENS, useValue: r?.pushTokens ?? new InMemoryPushTokenRepository() },
        { provide: NOTIFICATION_CONSENT, useValue: prod?.consent ?? new InMemoryConsentPort() },
        {
          provide: NOTIFICATION_CONTACTS,
          useValue: prod?.contacts ?? new InMemoryContactPort(options.defaultContact ?? null),
        },
        { provide: NOTIFICATION_PROVIDERS, useValue: providers },
        { provide: NOTIFICATION_EVENTS, useValue: prod?.events ?? new InMemoryNotificationEvents() },
        { provide: NOTIFICATION_ANALYTICS, useValue: prod?.analytics ?? new InMemoryAnalytics() },
        { provide: NOTIFICATION_INBOX_PROCESSED, useValue: prod?.inboxProcessed ?? new InMemoryInboxProcessed() },
        {
          provide: SEND_NOTIFICATION,
          inject: [
            NOTIFICATION_TEMPLATES, NOTIFICATION_REQUESTS, NOTIFICATION_LOG, NOTIFICATION_FREQUENCY,
            NOTIFICATION_PREFERENCES_REPO, NOTIFICATION_SUPPRESSIONS, NOTIFICATION_INBOX_REPO, NOTIFICATION_PUSH_TOKENS,
            NOTIFICATION_CONSENT, NOTIFICATION_CONTACTS, NOTIFICATION_PROVIDERS, NOTIFICATION_EVENTS,
            NOTIFICATION_ANALYTICS, CLOCK, ID_GENERATOR,
          ],
          useFactory: (
            templatesRepo: TemplateRepository,
            requests: RequestRepository,
            log: DeliveryLogRepository,
            frequency: FrequencyStore,
            preferences: PreferenceRepository,
            suppressions: SuppressionRepository,
            inbox: InboxRepository,
            tokens: PushTokenRepository,
            consent: ConsentPort,
            contacts: ContactPort,
            registry: ProviderRegistry,
            events: NotificationEventPublisher,
            analytics: AnalyticsPort,
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
          useFactory: (r: RequestRepository, s: SendNotification, c: Clock) => new ProcessDue(r, s, c),
        },
        {
          provide: HANDLE_DOMAIN_EVENT,
          inject: [NOTIFICATION_INBOX_PROCESSED, SEND_NOTIFICATION, NOTIFICATION_SUPPRESSIONS],
          useFactory: (p: InboxProcessedPort, s: SendNotification, sup: SuppressionRepository) =>
            new HandleDomainEvent(p, s, sup),
        },
        {
          provide: NOTIFICATION_PREFERENCES,
          inject: [NOTIFICATION_PREFERENCES_REPO, NOTIFICATION_SUPPRESSIONS, NOTIFICATION_CONSENT, CLOCK],
          useFactory: (
            p: PreferenceRepository,
            s: SuppressionRepository,
            c: ConsentPort,
            clock: Clock,
          ) => new NotificationPreferences(p, s, c, clock),
        },
        {
          provide: LIST_INBOX,
          inject: [NOTIFICATION_INBOX_REPO, CLOCK],
          useFactory: (i: InboxRepository, c: Clock) => new ListInbox(i, c),
        },
        {
          provide: MARK_INBOX_READ,
          inject: [NOTIFICATION_INBOX_REPO, CLOCK],
          useFactory: (i: InboxRepository, c: Clock) => new MarkInboxRead(i, c),
        },
        {
          provide: REGISTER_PUSH_TOKEN,
          inject: [NOTIFICATION_PUSH_TOKENS, CLOCK],
          useFactory: (t: PushTokenRepository, c: Clock) => new RegisterPushToken(t, c),
        },
      ],
      exports: [SEND_NOTIFICATION, HANDLE_DOMAIN_EVENT, PROCESS_DUE_NOTIFICATIONS],
    };
  }
}
