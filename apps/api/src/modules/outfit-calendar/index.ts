/** Public surface of the outfit calendar module (A2.3). Other code imports only this file. */
export { OutfitCalendarModule, type CalendarModuleOptions } from "./calendar.module";
export * from "./adapters/tokens";
export { FakeNotifier, InMemoryCalendarStore, StaticEta, UnknownEta } from "./adapters/in-memory";
export { KyselyOutfitCalendarStore, type OutfitCalendarDb } from "./adapters/kysely-store";
export { KyselyStoreDeliveryEta } from "./adapters/eta";
export { NotificationsReminderNotifier, REMINDER_TEMPLATE_DAY, REMINDER_TEMPLATE_WEEK } from "./adapters/notifier";
export { DEFAULT_CALENDAR_CONFIG, FLAG_GAP_FILL, FLAG_REMINDERS, type CalendarConfig, type StylistPorts } from "./application/shared";
export type { ProcessDueReminders, ProcessRemindersResult } from "./application/reminders";
export type {
  CalendarEvent,
  CalendarStore,
  DeliveryEtaPort,
  NotifyResult,
  OutfitLink,
  ReminderNotifierPort,
} from "./domain/ports";
