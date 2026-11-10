import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ConsentPurpose } from "@outlet/privacy";
import { cairoParts, decide, isQuietHour, localeChain, MARKETING_PURPOSE, nextAllowedTime, renderTemplate } from "../src/index.js";
import type { Category, Channel, DecideInput, Template } from "../src/index.js";

const CH: readonly Channel[] = ["push", "in_app", "whatsapp", "sms", "email"];
const PURPOSES: readonly ConsentPurpose[] = ["marketing_push", "marketing_whatsapp", "marketing_email", "analytics"];
const base = Date.UTC(2026, 10, 1);
const instant = fc.integer({ min: 0, max: 400 * 24 * 60 }).map((m) => new Date(base + m * 60_000)); // spans DST changes
const input = (over: Partial<DecideInput>): DecideInput => ({
  category: "marketing", channel: "push", grantedConsents: new Set(["marketing_push"]), preferenceEnabled: undefined,
  now: new Date(Date.UTC(2026, 10, 8, 10, 0)), recentSends: [], killed: false, ...over,
});

describe("decide", () => {
  it("marketing is never sent without the channel consent, whatever else is true", () => {
    fc.assert(
      fc.property(fc.constantFrom(...CH), fc.subarray([...PURPOSES]), instant, fc.option(fc.boolean(), { nil: undefined }), (channel, granted, now, pref) => {
        const d = decide(input({ channel, grantedConsents: new Set(granted), now, preferenceEnabled: pref }));
        const purpose = MARKETING_PURPOSE[channel];
        const consented = purpose !== null && granted.includes(purpose);
        if (channel === "sms" || (purpose !== null && !consented)) expect(d.kind === "send" || d.kind === "defer").toBe(false);
        if (d.kind === "suppress" && !consented && purpose !== null) expect(d.reason === "consent" || d.reason === "unsubscribed").toBe(true);
      }),
    );
  });

  it("transactional ignores quiet hours, caps and consent; only a kill switch or the user's own mute stops it", () => {
    fc.assert(
      fc.property(fc.constantFrom(...CH), instant, fc.array(instant, { maxLength: 10 }), (channel, now, recent) => {
        expect(decide(input({ category: "transactional", channel, grantedConsents: new Set(), now, recentSends: recent })).kind).toBe("send");
      }),
    );
    expect(decide(input({ category: "transactional", killed: true }))).toEqual({ kind: "suppress", reason: "killed" });
    expect(decide(input({ category: "transactional", preferenceEnabled: false }))).toEqual({ kind: "suppress", reason: "unsubscribed" });
  });

  it("marketing push caps hold over any sequence of attempts (rolling 1 per 24 h, 3 per 7 days)", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 20 * 24 * 60 }), { minLength: 1, maxLength: 60 }), (mins) => {
        const sent: Date[] = [];
        for (const m of [...mins].sort((a, b) => a - b)) {
          const now = new Date(base + m * 60_000);
          if (decide(input({ now, recentSends: sent })).kind === "send") sent.push(now);
        }
        for (const s of sent) {
          const t = s.getTime();
          expect(sent.filter((x) => x.getTime() > t - 86_400_000 && x.getTime() <= t).length).toBeLessThanOrEqual(1);
          expect(sent.filter((x) => x.getTime() > t - 7 * 86_400_000 && x.getTime() <= t).length).toBeLessThanOrEqual(3);
        }
      }),
    );
  });

  it("a defer always lands inside 09:00-23:00 Cairo, in the future, and a send never happens in quiet hours", () => {
    fc.assert(
      fc.property(instant, (now) => {
        const d = decide(input({ now }));
        if (d.kind === "defer") {
          expect(d.until.getTime()).toBeGreaterThan(now.getTime());
          const h = cairoParts(d.until).hour;
          expect(h).toBeGreaterThanOrEqual(9);
          expect(h).toBeLessThan(23);
          expect(isQuietHour(now)).toBe(true);
        }
        if (d.kind === "send") expect(isQuietHour(now)).toBe(false);
      }),
    );
  });

  it("nextAllowedTime is 09:00 local, same morning after midnight and next morning after 23:00, across DST", () => {
    const at = (iso: string): Date => new Date(iso);
    expect(cairoParts(nextAllowedTime(at("2026-11-08T22:30:00Z")))).toMatchObject({ day: 9, hour: 9, minute: 0 }); // 00:30 Cairo (UTC+2) -> 09:00 same day
    expect(cairoParts(nextAllowedTime(at("2026-11-08T21:30:00Z")))).toMatchObject({ day: 9, hour: 9 }); // 23:30 Cairo -> next morning
    expect(cairoParts(nextAllowedTime(at("2026-07-01T20:30:00Z")))).toMatchObject({ day: 2, hour: 9 }); // 23:30 Cairo (UTC+3)
    const noon = at("2026-11-08T10:00:00Z");
    expect(nextAllowedTime(noon)).toBe(noon);
  });

  it("applies kill, preference and push cap suppression reasons", () => {
    expect(decide(input({ killed: true }))).toEqual({ kind: "suppress", reason: "killed" });
    expect(decide(input({ preferenceEnabled: false }))).toEqual({ kind: "suppress", reason: "unsubscribed" });
    const now = new Date(Date.UTC(2026, 10, 8, 10, 0));
    expect(decide(input({ now, recentSends: [new Date(now.getTime() - 3_600_000)] }))).toEqual({ kind: "suppress", reason: "cap" });
    expect(decide(input({ channel: "whatsapp", grantedConsents: new Set(["marketing_whatsapp"]), now, recentSends: [new Date(now.getTime() - 3_600_000)] })).kind).toBe("send");
    expect(decide(input({ now: new Date(Date.UTC(2026, 10, 8, 21, 30)) })).kind).toBe("defer");
  });
});

const tpl = (over: Partial<Template>): Template => ({
  code: "order_paid", channel: "push", locale: "ar-EG", version: 1, category: "transactional", title: "t", body: "دفعت {amount}", providerTemplateName: null, approvalStatus: "approved", ...over,
});

describe("renderTemplate", () => {
  const ar = tpl({});
  const en = tpl({ locale: "en-EG", body: "Paid {amount}", title: "T" });
  it("orders locales user, then Arabic, then English", () => {
    expect(localeChain("en-EG")).toEqual(["en-EG", "ar-EG"]);
    expect(localeChain("ar-EG")).toEqual(["ar-EG", "en-EG"]);
  });
  it("picks the user's locale, falls back to AR then EN, newest approved version wins", () => {
    const r = (list: Template[], l: "ar-EG" | "en-EG") => renderTemplate(list, "order_paid", "push", l, { amount: "5" });
    expect(r([ar, en], "en-EG")).toMatchObject({ ok: true, value: { locale: "en-EG", body: "Paid 5" } });
    expect(r([en], "ar-EG")).toMatchObject({ ok: true, value: { locale: "en-EG" } });
    expect(r([ar], "en-EG")).toMatchObject({ ok: true, value: { locale: "ar-EG" } });
    expect(r([ar, tpl({ version: 2, body: "جديد {amount}" })], "ar-EG")).toMatchObject({ value: { body: "جديد 5" } });
    expect(r([ar, tpl({ version: 2, approvalStatus: "rejected" })], "ar-EG")).toMatchObject({ value: { body: "دفعت 5" } });
  });
  it("never returns a raw key or pattern: missing variable or no template is a typed failure", () => {
    expect(renderTemplate([ar], "order_paid", "push", "ar-EG", {})).toEqual({ ok: false, reason: "no_template" });
    expect(renderTemplate([ar], "unknown", "push", "ar-EG", {})).toEqual({ ok: false, reason: "no_template" });
    expect(renderTemplate([tpl({ body: "ok {broken" })], "order_paid", "push", "ar-EG", {})).toMatchObject({ ok: false });
    expect(renderTemplate([tpl({ channel: "whatsapp", approvalStatus: "pending", providerTemplateName: "x" })], "order_paid", "whatsapp", "ar-EG", { amount: "1" })).toEqual({ ok: false, reason: "template_not_approved" });
  });
  it("property: output never contains an unresolved placeholder", () => {
    fc.assert(
      fc.property(fc.constantFrom<Category>("transactional", "marketing"), fc.string({ maxLength: 8 }), (_c, v) => {
        const r = renderTemplate([ar, en], "order_paid", "push", "en-EG", { amount: v });
        if (r.ok) expect(r.value.body).not.toMatch(/\{amount\}/);
      }),
    );
  });
});
