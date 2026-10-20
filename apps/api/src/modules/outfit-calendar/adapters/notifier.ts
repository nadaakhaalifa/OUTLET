import type { ModuleRef } from "@nestjs/core";
import { SEND_NOTIFICATION, type SendNotification } from "../../notifications";
import type { NotifyResult, ReminderNotifierPort } from "../domain/ports";

/** Template keys seeded by notifications (calendar-templates.ts): service messages, no payload. */
export const REMINDER_TEMPLATE_WEEK = "calendar_reminder_week";
export const REMINDER_TEMPLATE_DAY = "calendar_reminder_day";

export const reminderTemplateFor = (offsetDays: number): string => (offsetDays >= 7 ? REMINDER_TEMPLATE_WEEK : REMINDER_TEMPLATE_DAY);

/** Minimal shape of `SendNotification.execute` this adapter needs (keeps tests free of the whole module). */
export interface SendFn {
  execute(input: {
    readonly userId: string;
    readonly templateKey: string;
    readonly ref: string;
    readonly payload: Readonly<Record<string, string | number>>;
    readonly deepLink?: string | null;
    readonly expiresAtMs?: number;
  }): ReturnType<SendNotification["execute"]>;
}

/**
 * Sends through the notifications module, which owns channel choice, preferences, suppression, the
 * inbox mirror and delivery logs. The message is a service message: it carries no event note and no
 * budget, only a template key and a deep link. `ref` repeats the (event, due_at) dedupe key, so a
 * retry after a crash is a "duplicate" there, never a second message.
 */
export class NotificationsReminderNotifier implements ReminderNotifierPort {
  constructor(private readonly sender: () => SendFn) {}

  static lazy(ref: ModuleRef): NotificationsReminderNotifier {
    return new NotificationsReminderNotifier(() => ref.get<SendNotification>(SEND_NOTIFICATION, { strict: false }));
  }

  async send(input: { readonly userId: string; readonly eventId: string; readonly dueAtMs: number; readonly offsetDays: number }): Promise<NotifyResult> {
    const r = await this.sender().execute({
      userId: input.userId,
      templateKey: reminderTemplateFor(input.offsetDays),
      ref: `${input.eventId}:${input.dueAtMs}`,
      payload: {},
      deepLink: `/calendar/events/${input.eventId}`,
      // A reminder that cannot go out within a day is stale.
      expiresAtMs: input.dueAtMs + 24 * 3_600_000,
    });
    switch (r.kind) {
      case "duplicate":
        return "deduplicated";
      case "rejected":
        return "rejected";
      case "accepted":
        if (r.status === "FAILED") return "unavailable";
        if (r.status === "SUPPRESSED") return "suppressed";
        return "sent";
    }
  }
}
