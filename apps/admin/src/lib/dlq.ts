import { intlTag, type Locale } from "@outlet/i18n";
import { z } from "zod";

/** Relay dead-letter queue wire shapes (GET /admin/dlq). Never a payload: ids, event type, attempts and an error code only. */
export const DISCARD_REASONS = ["duplicate", "obsolete", "poison_payload", "handled_manually", "test_data"] as const;
export type DiscardReason = (typeof DISCARD_REASONS)[number];

export const DlqEntry = z.object({
  id: z.uuid(),
  event_id: z.uuid(),
  event_type: z.string(),
  attempts: z.number().int(),
  last_error: z.string().nullable().optional(),
  dead_lettered_at: z.string(),
});
export type DlqEntryView = z.infer<typeof DlqEntry>;
export const DlqPage = z.object({ items: z.array(DlqEntry), next_cursor: z.string().nullable().optional() });

export const DLQ_MAX_IDS = 50;

/** Money event types: discarding one needs a second approver (the API decides; this only warns before the click). */
export const isMoneyType = (t: string): boolean => t === "order_group.late_payment_refund" || t.startsWith("refund.") || t.startsWith("promotions.") || t.startsWith("payout.");

/** Whole-unit relative age ("3 hours ago"), by the largest unit that fits. `now` is passed in so server and client render the same text. */
export function ageLabel(iso: string, now: Date, locale: Locale): string {
  const ms = now.getTime() - Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const f = new Intl.RelativeTimeFormat(intlTag(locale, undefined), { numeric: "auto" });
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 60) return f.format(-min, "minute");
  if (min < 60 * 24) return f.format(-Math.floor(min / 60), "hour");
  return f.format(-Math.floor(min / (60 * 24)), "day");
}
