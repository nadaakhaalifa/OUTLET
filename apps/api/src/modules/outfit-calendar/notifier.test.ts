import { describe, expect, it } from "vitest";
import { NotificationsReminderNotifier, REMINDER_TEMPLATE_DAY, REMINDER_TEMPLATE_WEEK, reminderTemplateFor, type SendFn } from "./adapters/notifier";
import { seedTemplates } from "../notifications";

type Res = Awaited<ReturnType<SendFn["execute"]>>;
const run = async (res: Res, offsetDays = 7) => {
  const calls: Parameters<SendFn["execute"]>[0][] = [];
  const n = new NotificationsReminderNotifier(() => ({
    execute: async (i) => {
      calls.push(i);
      return res;
    },
  }));
  const out = await n.send({ userId: "u", eventId: "e1", dueAtMs: 1234, offsetDays });
  return { out, calls };
};

describe("NotificationsReminderNotifier", () => {
  it("sends a payload-free service message keyed by (event, due_at) with a deep link", async () => {
    const { out, calls } = await run({ kind: "accepted", requestId: "r", status: "SENT", channel: "push", suppressedReason: null, inbox: true, reasons: [] });
    expect(out).toBe("sent");
    expect(calls[0]).toMatchObject({ templateKey: REMINDER_TEMPLATE_WEEK, ref: "e1:1234", payload: {}, deepLink: "/calendar/events/e1" });
    expect(reminderTemplateFor(1)).toBe(REMINDER_TEMPLATE_DAY);
  });
  it("maps duplicate, rejected, suppressed and failed results", async () => {
    expect((await run({ kind: "duplicate", requestId: "r", status: "SENT" })).out).toBe("deduplicated");
    expect((await run({ kind: "rejected", reason: "unknown_template" })).out).toBe("rejected");
    const base = { kind: "accepted" as const, requestId: "r", channel: null, suppressedReason: null, inbox: false, reasons: [] };
    expect((await run({ ...base, status: "SUPPRESSED" })).out).toBe("suppressed");
    expect((await run({ ...base, status: "FAILED" })).out).toBe("unavailable");
  });
  it("the seeded templates exist for both keys, are transactional and carry no placeholders or amounts", () => {
    const t = seedTemplates().filter((x) => x.key.startsWith("calendar_reminder_"));
    expect(new Set(t.map((x) => x.key))).toEqual(new Set([REMINDER_TEMPLATE_WEEK, REMINDER_TEMPLATE_DAY]));
    for (const x of t) {
      expect(x.category).toBe("transactional");
      expect(x.bodyAr.length).toBeGreaterThan(0);
      expect(`${x.bodyAr}${x.bodyEn ?? ""}`).not.toMatch(/\{\{|\d/);
    }
  });
});
