import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyticsEvents, ANALYTICS_EVENT_NAMES } from "./analytics-events";
import { renderEventsDoc } from "./events-doc";
import { VALID_PROPS } from "./test-fixtures";
import { createRecordingTransport, ConsentGatedTracker } from "./tracker";

// Walk up to the repo docs so the check also works inside Stryker's sandbox copy (.stryker-tmp/...).
const findDoc = (): string => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i += 1) {
    const candidate = join(dir, "docs", "analytics", "events.md");
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error("docs/analytics/events.md not found");
};
const DOC = findDoc();

describe("events.md registry check", () => {
  it("committed doc matches the generated output", () => {
    if (process.env["UPDATE_EVENTS_DOC"] === "1") writeFileSync(DOC, renderEventsDoc());
    expect(readFileSync(DOC, "utf8")).toBe(renderEventsDoc());
  });
  it("has one row per event", () => {
    const doc = renderEventsDoc();
    for (const n of ANALYTICS_EVENT_NAMES) expect(doc).toContain(`| \`${n}\` | ${analyticsEvents[n].version} |`);
  });
});

describe("phase 2 events", () => {
  const P2 = [
    "plus_paywall_viewed", "plus_started", "plus_renewed", "plus_payment_failed", "plus_cancelled",
    "gift_card_purchased", "gift_card_redeemed", "budget_set", "budget_warning_shown", "budget_cap_blocked_checkout",
    "affordability_view_opened", "stylist_outfit_generated", "outfit_added_to_bag", "stylist_feedback", "coins_earned",
    "game_played", "drop_joined_queue", "drop_admitted", "ad_impression", "ad_click", "review_submitted",
    "review_reported", "referral_shared", "referral_converted", "consent_changed", "recommendation_impression",
    "recommendation_click", "history_cleared", "personalization_changed",
  ] as const;
  it("all exist with versions >= 1", () => {
    for (const n of P2) {
      expect(ANALYTICS_EVENT_NAMES, n).toContain(n);
      expect(analyticsEvents[n].version).toBeGreaterThanOrEqual(1);
    }
  });
  it("no property name suggests contact data, DOB, address, measurements", () => {
    const bad = /(phone|email|dob|birth|address|measure|height|weight|waist|bust|hip)/;
    for (const n of ANALYTICS_EVENT_NAMES) for (const k of Object.keys(analyticsEvents[n].shape)) expect(k, `${n}.${k}`).not.toMatch(bad);
  });
  it("budget and ad events carry no amounts", () => {
    for (const n of ANALYTICS_EVENT_NAMES) {
      const d = analyticsEvents[n];
      if (d.owner === "budget" || d.owner === "ads") {
        for (const k of Object.keys(d.shape)) expect(k, `${n}.${k}`).not.toMatch(/(amount|minor|total|spend|cost|price)/);
      }
    }
    expect(analyticsEvents.stylist_outfit_generated.shape).not.toHaveProperty("budget_amount_minor");
  });
  it("game_played only accepts odds_disclosed true", () => {
    const s = analyticsEvents.game_played.schema;
    expect(s.safeParse(VALID_PROPS.game_played).success).toBe(true);
    expect(s.safeParse({ ...VALID_PROPS.game_played, odds_disclosed: false }).success).toBe(false);
  });
  it("sponsored events carry no user identifiers or query", () => {
    for (const n of ["ad_impression", "ad_click"] as const) {
      expect(Object.keys(analyticsEvents[n].shape).sort()).not.toEqual(expect.arrayContaining(["user_id"]));
      expect(analyticsEvents[n].origin).toBe("server");
    }
  });
  it("budget events are consent-gated by budget_insights; tracker drops without consent", async () => {
    const transport = createRecordingTransport();
    const t = new ConsentGatedTracker({
      origin: "client",
      consent: { isGranted: () => false },
      transport,
      clock: { now: () => new Date("2026-10-11T00:00:00Z") },
      ids: { next: () => "evt_1" },
      pseudonymousId: { current: () => "px_aaaaaaaaaaaaaaaa" },
      platform: "android",
    });
    const r = await t.track("budget_set", VALID_PROPS.budget_set);
    expect(r).toEqual({ status: "dropped", reason: "consent_not_granted" });
    expect(transport.sent).toHaveLength(0);
  });
  it("envelope carries platform and event version", async () => {
    const transport = createRecordingTransport();
    const t = new ConsentGatedTracker({
      origin: "client",
      consent: { isGranted: () => true },
      transport,
      clock: { now: () => new Date("2026-10-11T00:00:00Z") },
      ids: { next: () => "evt_1" },
      pseudonymousId: { current: () => "px_aaaaaaaaaaaaaaaa" },
      platform: "android",
    });
    await t.track("review_reported", VALID_PROPS.review_reported);
    expect(transport.sent[0]?.platform).toBe("android");
    expect(transport.sent[0]?.schema_version).toBe(1);
  });
});
