import { capDecision, deferOutOfQuietHours, inQuietHours } from "../domain/bridge";
import type { ClaimedReminder, SkipReason } from "../domain/ports";
import { FLAG_REMINDERS, DAY_MS, flagOn, type CalendarDeps } from "./shared";

export interface ProcessRemindersResult {
  readonly claimed: number;
  readonly sent: number;
  readonly deferred: number;
  readonly skipped: number;
  readonly retried: number;
  readonly failed: number;
  readonly archived: number;
}

const BACKOFF_BASE_MS = 5 * 60_000;

/**
 * Worker job: sends due reminders. Order of checks per reminder: event still upcoming, reminders
 * still on, kill switch, quiet hours (23:00-09:00 Africa/Cairo) and the frequency cap (both defer),
 * then the notification. The unique (event, due_at) row is the dedupe key; the notification ref
 * repeats it, so a crash between send and mark never produces a second message.
 */
export class ProcessDueReminders {
  constructor(private readonly d: CalendarDeps) {}

  async execute(limit: number): Promise<ProcessRemindersResult> {
    const d = this.d;
    const r = { claimed: 0, sent: 0, deferred: 0, skipped: 0, retried: 0, failed: 0, archived: 0 };
    const now = d.clock.nowMs();
    r.archived = await d.store.archivePast(now);
    if (!(await flagOn(d.flags, FLAG_REMINDERS))) return r; // rows stay pending, nothing is claimed
    const claimed = await d.store.claimDueReminders(now, limit, d.cfg.reminderLeaseMs);
    r.claimed = claimed.length;
    for (const rem of claimed) {
      const outcome = await this.one(rem);
      r[outcome] += 1;
    }
    return r;
  }

  private async skip(rem: ClaimedReminder, reason: SkipReason): Promise<"skipped"> {
    await this.d.store.finishReminder(rem.id, "skipped", reason, this.d.clock.nowMs(), []);
    return "skipped";
  }

  private async defer(rem: ClaimedReminder, untilMs: number): Promise<"deferred" | "skipped"> {
    if (untilMs >= rem.startsAtMs) return this.skip(rem, "event_past");
    const ok = await this.d.store.rescheduleReminder(rem.id, untilMs);
    if (!ok) return this.skip(rem, "duplicate");
    return "deferred";
  }

  private async one(rem: ClaimedReminder): Promise<"sent" | "deferred" | "skipped" | "retried" | "failed"> {
    const d = this.d;
    const now = d.clock.nowMs();
    if (rem.eventStatus !== "active" || rem.startsAtMs <= now) return this.skip(rem, "event_past");
    if (!rem.remindersEnabled) return this.skip(rem, "reminders_off");

    if (inQuietHours(now)) return this.defer(rem, deferOutOfQuietHours(now));
    const sent = await d.store.sentTimesSince(rem.userId, now - 7 * DAY_MS);
    const cap = capDecision(sent, now);
    if (cap.kind === "defer") return this.defer(rem, cap.untilMs);

    let result: Awaited<ReturnType<CalendarDeps["notifier"]["send"]>>;
    try {
      result = await d.notifier.send({ userId: rem.userId, eventId: rem.eventId, dueAtMs: rem.dueAtMs, offsetDays: rem.offsetDays });
    } catch {
      result = "unavailable";
    }
    switch (result) {
      case "sent":
      case "deduplicated":
        await d.store.finishReminder(rem.id, "sent", null, now, [
          { type: "calendar.reminder_due", eventId: rem.eventId, userId: rem.userId, offsetDays: rem.offsetDays, dueAtMs: rem.dueAtMs },
        ]);
        return "sent";
      case "suppressed":
      case "rejected":
        return this.skip(rem, "rejected");
      case "unavailable": {
        const attempts = rem.attempts + 1;
        if (attempts >= d.cfg.maxReminderAttempts) {
          await d.store.finishReminder(rem.id, "failed", null, now, []);
          return "failed";
        }
        // Exponential backoff: 5, 10, 20, 40 minutes. The reminder never moves past the event.
        const next = Math.min(now + BACKOFF_BASE_MS * 2 ** (attempts - 1), rem.startsAtMs - 1);
        await d.store.retryReminder(rem.id, next, attempts);
        return "retried";
      }
    }
  }
}
