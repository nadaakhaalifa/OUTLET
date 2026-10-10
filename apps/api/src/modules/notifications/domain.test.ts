// fast-check is a dependency of the workspace packages, not of apps/api (no new packages in this wave).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  addDaysToDateKey,
  cairoLocalToUtc,
  cairoOffsetMinutes,
  cairoParts,
  dstEndMs,
  dstStartMs,
  formatHhmm,
  isInQuietHours,
  nextQuietEnd,
  parseHhmm,
  trailingDateKeys,
} from "./domain/cairo-time";
import { decideChannel, frequencyUsage, retryDelayMs, BACKOFF_CAP_MS, type ChannelDecisionInput } from "./domain/policy";
import { checkActivation, checkPayload, isSafeDeepLink, renderTemplate } from "./domain/templates";
import { DEFAULT_CAPS, DEFAULT_QUIET_HOURS, type NotificationTemplate } from "./domain/types";

const HOUR = 3_600_000;
const Q = DEFAULT_QUIET_HOURS;

describe("Cairo offset rule", () => {
  it("is UTC+2 in winter and UTC+3 in summer", () => {
    expect(cairoOffsetMinutes(Date.UTC(2027, 0, 15, 12))).toBe(120);
    expect(cairoOffsetMinutes(Date.UTC(2027, 6, 1, 12))).toBe(180);
  });

  it("switches exactly at the 2027 transitions (last Friday of April, last Thursday of October)", () => {
    const start = dstStartMs(2027);
    expect(new Date(start).toISOString()).toBe("2027-04-29T22:00:00.000Z");
    expect(cairoOffsetMinutes(start - 1)).toBe(120);
    expect(cairoOffsetMinutes(start)).toBe(180);
    const end = dstEndMs(2027);
    expect(new Date(end).toISOString()).toBe("2027-10-28T21:00:00.000Z");
    expect(cairoOffsetMinutes(end - 1)).toBe(180);
    expect(cairoOffsetMinutes(end)).toBe(120);
  });

  it("matches the 2024 official dates (26 April and 31 October)", () => {
    expect(new Date(dstStartMs(2024)).toISOString()).toBe("2024-04-25T22:00:00.000Z");
    expect(new Date(dstEndMs(2024)).toISOString()).toBe("2024-10-31T21:00:00.000Z");
  });

  it("agrees with the host tz database around every transition 2024..2030 and on sampled days", () => {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "Africa/Cairo", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    });
    const offsetViaIntl = (ms: number): number => {
      const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
      const local = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
      return (local - Math.floor(ms / 60_000) * 60_000) / 60_000;
    };
    const points: number[] = [];
    for (let y = 2024; y <= 2030; y += 1) {
      for (const t of [dstStartMs(y), dstEndMs(y)]) for (const d of [-2 * HOUR, -1, 0, 1, 2 * HOUR]) points.push(t + d);
      for (let day = 0; day < 365; day += 11) points.push(Date.UTC(y, 0, 1 + day, 7, 30));
    }
    for (const ms of points) expect(cairoOffsetMinutes(ms), new Date(ms).toISOString()).toBe(offsetViaIntl(ms));
  });
});

describe("Cairo local time", () => {
  it("round-trips local wall time to UTC outside the transition hours", () => {
    for (const [date, h] of [["2027-01-15", 10], ["2027-07-01", 10], ["2027-04-30", 9], ["2027-10-29", 9]] as const) {
      const utc = cairoLocalToUtc(date, h * 60);
      const p = cairoParts(utc);
      expect([p.dateKey, p.hour, p.minute]).toEqual([date, h, 0]);
    }
  });

  it("does calendar arithmetic on date keys across month and year ends", () => {
    expect(addDaysToDateKey("2027-12-31", 1)).toBe("2028-01-01");
    expect(addDaysToDateKey("2028-03-01", -1)).toBe("2028-02-29");
    expect(trailingDateKeys(cairoLocalToUtc("2027-01-02", 10 * 60), 3)).toEqual(["2027-01-02", "2027-01-01", "2026-12-31"]);
  });

  it("uses the Cairo day, not the UTC day (21:30Z is the next Cairo day in summer, 22:30Z in winter)", () => {
    expect(cairoParts(Date.UTC(2027, 6, 1, 21, 30)).dateKey).toBe("2027-07-02");
    expect(cairoParts(Date.UTC(2027, 0, 1, 22, 30)).dateKey).toBe("2027-01-02");
    expect(cairoParts(Date.UTC(2027, 0, 1, 21, 30)).dateKey).toBe("2027-01-01");
  });

  it("parses and formats HH:MM", () => {
    expect(parseHhmm("23:00")).toBe(1380);
    expect(parseHhmm("24:00")).toBeNull();
    expect(parseHhmm("9:00")).toBeNull();
    expect(formatHhmm(540)).toBe("09:00");
  });
});

describe("quiet hours 23:00 to 09:00", () => {
  const at = (date: string, h: number, m: number, s = 0): number => cairoLocalToUtc(date, h * 60 + m) + s * 1000;

  it("boundaries are exact", () => {
    expect(isInQuietHours(at("2027-01-15", 22, 59, 59), Q)).toBe(false);
    expect(isInQuietHours(at("2027-01-15", 23, 0), Q)).toBe(true);
    expect(isInQuietHours(at("2027-01-16", 8, 59, 59), Q)).toBe(true);
    expect(isInQuietHours(at("2027-01-16", 9, 0), Q)).toBe(false);
  });

  it("defers an evening message to 09:00 the next day and a night message to 09:00 the same day", () => {
    expect(nextQuietEnd(at("2027-01-15", 23, 30), Q)).toBe(at("2027-01-16", 9, 0));
    expect(nextQuietEnd(at("2027-01-16", 2, 0), Q)).toBe(at("2027-01-16", 9, 0));
    expect(nextQuietEnd(at("2027-01-15", 12, 0), Q)).toBe(at("2027-01-15", 12, 0));
  });

  it("is correct across the DST start night (Thursday 23:30 EET then Friday 09:00 EEST)", () => {
    const from = Date.UTC(2027, 3, 29, 21, 30); // 23:30 EET
    expect(isInQuietHours(from, Q)).toBe(true);
    expect(new Date(nextQuietEnd(from, Q)).toISOString()).toBe("2027-04-30T06:00:00.000Z");
  });

  it("is correct across the DST end night, in both passes of the repeated hour", () => {
    const first = Date.UTC(2027, 9, 28, 20, 30); // 23:30 EEST
    const second = Date.UTC(2027, 9, 28, 21, 30); // 23:30 EET again
    expect(new Date(nextQuietEnd(first, Q)).toISOString()).toBe("2027-10-29T07:00:00.000Z");
    expect(new Date(nextQuietEnd(second, Q)).toISOString()).toBe("2027-10-29T07:00:00.000Z");
  });

  it("property: the end of quiet hours is outside quiet hours, not earlier, and within 11 hours (the repeated DST hour adds one)", () => {
    fc.assert(
      fc.property(fc.integer({ min: Date.UTC(2024, 0, 1), max: Date.UTC(2031, 0, 1) }), (ms) => {
        const end = nextQuietEnd(ms, Q);
        expect(end).toBeGreaterThanOrEqual(ms);
        expect(isInQuietHours(end, Q)).toBe(false);
        // 10 h normally; 11 h from 23:00 EEST on the night DST ends (the 23:00 hour occurs twice).
        expect(end - ms).toBeLessThanOrEqual(11 * HOUR);
        if (!isInQuietHours(ms, Q)) expect(end).toBe(ms);
      }),
      { numRuns: 2000 },
    );
  });
});

describe("frequency usage", () => {
  const noon = (d: string): number => cairoLocalToUtc(d, 12 * 60);
  it("counts the Cairo day and the trailing seven days", () => {
    const sent = [noon("2027-01-10"), noon("2027-01-14"), noon("2027-01-15")];
    expect(frequencyUsage(sent, noon("2027-01-15"))).toEqual({ day: 1, week: 3 });
    expect(frequencyUsage(sent, noon("2027-01-16"))).toEqual({ day: 0, week: 3 });
    // 7 Cairo days: the 10th is inside until the 16th, outside on the 17th.
    expect(frequencyUsage(sent, noon("2027-01-17")).week).toBe(2);
  });

  it("resets at Cairo midnight, not UTC midnight", () => {
    const lateEvening = cairoLocalToUtc("2027-01-14", 23 * 60 + 59);
    const justAfterMidnight = cairoLocalToUtc("2027-01-15", 1);
    expect(frequencyUsage([lateEvening], justAfterMidnight).day).toBe(0);
  });
});

const base: ChannelDecisionInput = {
  category: "marketing",
  channel: "push",
  nowMs: cairoLocalToUtc("2027-01-15", 12 * 60),
  suppressions: new Set(),
  consentGranted: true,
  typeEnabled: true,
  marketingSentAtMs: [],
  caps: DEFAULT_CAPS,
  quiet: Q,
  expiresAtMs: cairoLocalToUtc("2027-01-15", 12 * 60) + 6 * HOUR,
};

describe("decideChannel", () => {
  it("sends marketing with consent, preference on, no caps, daytime", () => {
    expect(decideChannel(base)).toEqual({ kind: "send" });
  });
  it("suppresses marketing without consent", () => {
    expect(decideChannel({ ...base, consentGranted: false })).toEqual({ kind: "suppress", reason: "NO_CONSENT" });
  });
  it("never sends SMS marketing, whatever the consent flag says", () => {
    expect(decideChannel({ ...base, channel: "sms", consentGranted: true })).toEqual({ kind: "suppress", reason: "NO_CONSENT" });
  });
  it("suppresses on a disabled type", () => {
    expect(decideChannel({ ...base, typeEnabled: false })).toEqual({ kind: "suppress", reason: "PREFERENCE" });
  });
  it("suppresses on an unsubscribe even with consent", () => {
    expect(decideChannel({ ...base, suppressions: new Set(["UNSUBSCRIBED"]) })).toEqual({ kind: "suppress", reason: "SUPPRESSION_LIST" });
  });
  it("defers in quiet hours and drops when the message expires first", () => {
    const night = cairoLocalToUtc("2027-01-15", 23 * 60 + 30);
    const r = decideChannel({ ...base, nowMs: night, expiresAtMs: night + 12 * HOUR });
    expect(r).toEqual({ kind: "defer", untilMs: cairoLocalToUtc("2027-01-16", 9 * 60) });
    expect(decideChannel({ ...base, nowMs: night, expiresAtMs: night + HOUR })).toEqual({ kind: "suppress", reason: "QUIET_HOURS" });
  });
  it("caps at 1 per day and 3 per week", () => {
    const noon = base.nowMs;
    expect(decideChannel({ ...base, marketingSentAtMs: [noon - HOUR] })).toEqual({ kind: "suppress", reason: "FREQUENCY_CAP" });
    const week = [1, 2, 3].map((d) => noon - d * 24 * HOUR);
    expect(decideChannel({ ...base, marketingSentAtMs: week })).toEqual({ kind: "suppress", reason: "FREQUENCY_CAP" });
    expect(decideChannel({ ...base, marketingSentAtMs: week.slice(0, 2) })).toEqual({ kind: "send" });
  });
  it("exempts transactional and security from consent, preference, quiet hours and caps", () => {
    const night = cairoLocalToUtc("2027-01-15", 23 * 60 + 30);
    for (const category of ["transactional", "security"] as const) {
      expect(
        decideChannel({ ...base, category, nowMs: night, consentGranted: false, typeEnabled: false, marketingSentAtMs: [night - 1, night - 2, night - 3] }),
      ).toEqual({ kind: "send" });
    }
  });
  it("technical suppression blocks every category", () => {
    for (const category of ["transactional", "marketing", "security"] as const) {
      expect(decideChannel({ ...base, category, suppressions: new Set(["INVALID_TOKEN"]) }).kind).toBe("suppress");
    }
  });

  it("property: marketing is sent only when consent, preference, caps and quiet hours all allow it", () => {
    fc.assert(
      fc.property(
        fc.record({
          consent: fc.boolean(),
          enabled: fc.boolean(),
          channel: fc.constantFrom("push", "whatsapp", "email", "sms"),
          now: fc.integer({ min: Date.UTC(2027, 0, 1), max: Date.UTC(2027, 11, 31) }),
          sent: fc.array(fc.integer({ min: 0, max: 9 * 24 * 60 }), { maxLength: 6 }),
          unsub: fc.boolean(),
        }),
        (x) => {
          const sentAt = x.sent.map((m) => x.now - m * 60_000);
          const d = decideChannel({
            ...base,
            channel: x.channel,
            nowMs: x.now,
            consentGranted: x.consent,
            typeEnabled: x.enabled,
            marketingSentAtMs: sentAt,
            suppressions: new Set(x.unsub ? (["UNSUBSCRIBED"] as const) : []),
            expiresAtMs: x.now + 24 * HOUR,
          });
          if (d.kind === "send") {
            const u = frequencyUsage(sentAt, x.now);
            expect(x.channel).not.toBe("sms");
            expect(x.consent && x.enabled && !x.unsub).toBe(true);
            expect(isInQuietHours(x.now, Q)).toBe(false);
            expect(u.day).toBeLessThan(DEFAULT_CAPS.perDay);
            expect(u.week).toBeLessThan(DEFAULT_CAPS.perWeek);
          }
          if (d.kind === "defer") expect(isInQuietHours(d.untilMs, Q)).toBe(false);
        },
      ),
      { numRuns: 1500 },
    );
  });
});

describe("retryDelayMs", () => {
  it("grows exponentially, is capped, is deterministic and jitter stays within 25%", () => {
    expect(retryDelayMs(3, "r")).toBe(retryDelayMs(3, "r"));
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 40 }), fc.string({ minLength: 1, maxLength: 20 }), (attempt, seed) => {
        const exp = Math.min(BACKOFF_CAP_MS, 30_000 * 2 ** (attempt - 1));
        const d = retryDelayMs(attempt, seed);
        expect(d).toBeGreaterThanOrEqual(exp);
        expect(d).toBeLessThanOrEqual(exp * 1.25);
      }),
    );
  });
});

const tpl = (over: Partial<NotificationTemplate> = {}): NotificationTemplate => ({
  id: "t", key: "k", version: 1, channel: "push", category: "transactional", type: "ORDER_UPDATES",
  subjectAr: "عنوان", subjectEn: "Title", bodyAr: "طلب {{order_no}}", bodyEn: "Order {{order_no}}",
  providerTemplateId: null, approval: "APPROVED", active: true, alertType: null, validFromMs: 0, ...over,
});

describe("templates", () => {
  it("cannot be activated without an Arabic body", () => {
    expect(checkActivation(tpl({ bodyAr: "   " }))).toBe("arabic_body_required");
    expect(checkActivation(tpl())).toBeNull();
  });
  it("requires matching placeholders between Arabic and English", () => {
    expect(checkActivation(tpl({ bodyEn: "Order {{other}}" }))).toBe("english_placeholder_mismatch");
    expect(checkActivation(tpl({ bodyEn: null }))).toBeNull();
  });
  it("requires an approved provider template for WhatsApp", () => {
    expect(checkActivation(tpl({ channel: "whatsapp" }))).toBe("whatsapp_template_id_required");
    expect(checkActivation(tpl({ channel: "whatsapp", providerTemplateId: "x", approval: "SUBMITTED" }))).toBe("whatsapp_not_approved");
    expect(checkActivation(tpl({ channel: "whatsapp", providerTemplateId: "x" }))).toBeNull();
  });
  it("requires an Arabic subject for email", () => {
    expect(checkActivation(tpl({ channel: "email", subjectAr: null }))).toBe("arabic_subject_required");
  });
  it("validates payloads strictly", () => {
    const t = tpl();
    expect(checkPayload(t, { order_no: "A1" })).toBeNull();
    expect(checkPayload(t, {})).toBe("missing_placeholder");
    expect(checkPayload(t, { order_no: "A1", extra: "x" })).toBe("unknown_key");
    expect(checkPayload(t, { order_no: "x".repeat(201) })).toBe("invalid_value");
    expect(checkPayload(t, { order_no: Number.NaN })).toBe("invalid_value");
  });
  it("renders Arabic by default, English when asked, Arabic when English is missing", () => {
    expect(renderTemplate(tpl(), { order_no: "A1" }, "ar").body).toBe("طلب A1");
    expect(renderTemplate(tpl(), { order_no: "A1" }, "en").body).toBe("Order A1");
    expect(renderTemplate(tpl({ bodyEn: null }), { order_no: "A1" }, "en").body).toBe("طلب A1");
  });
  it("strips control and bidi override characters and escapes email HTML", () => {
    const evil = "a‮b\u0000c<script>";
    expect(renderTemplate(tpl(), { order_no: evil }, "ar").body).toBe("طلب abc<script>");
    expect(renderTemplate(tpl({ channel: "email" }), { order_no: evil }, "ar").body).toBe("طلب abc&lt;script&gt;");
  });
  it("does not re-expand placeholders inside values", () => {
    expect(renderTemplate(tpl(), { order_no: "{{order_no}}" }, "ar").body).toBe("طلب {{order_no}}");
  });
  it("accepts only app routes as deep links", () => {
    expect(isSafeDeepLink("/orders/123")).toBe(true);
    for (const bad of ["https://evil.example", "//evil.example", "/a/../b", "javascript:alert(1)", ""]) {
      expect(isSafeDeepLink(bad)).toBe(false);
    }
  });
});
