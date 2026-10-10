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
} from "../adapters/in-memory";
import { seedTemplates } from "../adapters/seed-templates";
import { HandleDomainEvent } from "../application/handle-domain-event";
import { ListInbox, MarkInboxRead, RegisterPushToken } from "../application/inbox";
import { NotificationPreferences } from "../application/preferences";
import { ProcessDue, SendNotification } from "../application/send-notification";
import { cairoLocalToUtc } from "../domain/cairo-time";
import type { Clock, IdPort } from "../domain/ports";

export class MutableClock implements Clock {
  constructor(private ms: number) {}
  nowMs(): number {
    return this.ms;
  }
  set(ms: number): void {
    this.ms = ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

class CounterIds implements IdPort {
  private n = 0;
  uuidV7(): string {
    this.n += 1;
    return `00000000-0000-7000-8000-${String(this.n).padStart(12, "0")}`;
  }
}

/** A Cairo local wall-clock instant, for readable tests. */
export const cairo = (dateKey: string, hh: number, mm = 0): number => cairoLocalToUtc(dateKey, hh * 60 + mm);

export const U1 = "11111111-1111-4111-8111-111111111111";
export const U2 = "22222222-2222-4222-8222-222222222222";

export interface Rig {
  readonly clock: MutableClock;
  readonly sender: SendNotification;
  readonly due: ProcessDue;
  readonly handler: HandleDomainEvent;
  readonly prefs: NotificationPreferences;
  readonly inboxList: ListInbox;
  readonly inboxRead: MarkInboxRead;
  readonly registerToken: RegisterPushToken;
  readonly templates: InMemoryTemplateRepository;
  readonly requests: InMemoryRequestRepository;
  readonly log: InMemoryDeliveryLog;
  readonly inbox: InMemoryInboxRepository;
  readonly tokens: InMemoryPushTokenRepository;
  readonly consent: InMemoryConsentPort;
  readonly contacts: InMemoryContactPort;
  readonly suppressions: InMemorySuppressionRepository;
  readonly events: InMemoryNotificationEvents;
  readonly analytics: InMemoryAnalytics;
  readonly push: FakeProvider<"push">;
  readonly wa: FakeProvider<"whatsapp">;
  readonly smsPrimary: FakeProvider<"sms">;
  readonly smsBackup: FakeProvider<"sms">;
  readonly email: FakeProvider<"email">;
}

export async function buildRig(startMs: number): Promise<Rig> {
  const clock = new MutableClock(startMs);
  const templates = new InMemoryTemplateRepository();
  for (const t of seedTemplates()) await templates.save(t);
  const requests = new InMemoryRequestRepository();
  const log = new InMemoryDeliveryLog();
  const frequency = new InMemoryFrequencyStore();
  const preferences = new InMemoryPreferenceRepository();
  const suppressions = new InMemorySuppressionRepository();
  const inbox = new InMemoryInboxRepository();
  const tokens = new InMemoryPushTokenRepository();
  const consent = new InMemoryConsentPort();
  const contacts = new InMemoryContactPort(null);
  contacts.set(U1, { locale: "ar", phone: "+201001230001", email: "u1@example.invalid" });
  contacts.set(U2, { locale: "en", phone: "+201001230002", email: null });
  const push = new FakeProvider("expo_push", "push");
  const wa = new FakeProvider("wa_bsp", "whatsapp");
  const smsPrimary = new FakeProvider("sms_primary", "sms");
  const smsBackup = new FakeProvider("sms_backup", "sms");
  const email = new FakeProvider("email_primary", "email");
  const providers = new StaticProviderRegistry({ push: [push], whatsapp: [wa], sms: [smsPrimary, smsBackup], email: [email] });
  const events = new InMemoryNotificationEvents();
  const analytics = new InMemoryAnalytics();
  const ids = new CounterIds();
  const sender = new SendNotification({
    templates, requests, log, frequency, preferences, suppressions, inbox, tokens, consent, contacts, providers,
    events, analytics, clock, ids,
  });
  return {
    clock, sender, templates, requests, log, inbox, tokens, consent, contacts, suppressions, events, analytics,
    push, wa, smsPrimary, smsBackup, email,
    due: new ProcessDue(requests, sender, clock),
    handler: new HandleDomainEvent(new InMemoryInboxProcessed(), sender, suppressions),
    prefs: new NotificationPreferences(preferences, suppressions, consent, clock),
    inboxList: new ListInbox(inbox, clock),
    inboxRead: new MarkInboxRead(inbox, clock),
    registerToken: new RegisterPushToken(tokens, clock),
  };
}
