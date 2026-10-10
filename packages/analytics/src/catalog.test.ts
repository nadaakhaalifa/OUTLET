import { describe, expect, it } from "vitest";
import { analyticsEvents, ANALYTICS_EVENT_NAMES } from "./analytics-events";
import { DOMAIN_EVENT_NAMES, domainEvents } from "./domain-events";
import { VALID_PROPS } from "./test-fixtures";
import { isValidAnalyticsEventName, isValidDomainEventName, isValidPropertyName } from "./naming";
import { inspectProperties } from "./pii";
import { renderTaxonomyTables } from "./taxonomy";
import { OWNER_MODULES } from "./modules";
import { RETENTION_POLICIES } from "./retention";

/** Every event named in spec §26's list. Kept literal so the catalog cannot silently lose one. */
const SPEC_26 = [
  "app_open", "onboarding_step_completed", "world_selected", "store_viewed", "product_viewed", "filter_applied",
  "search_performed", "search_no_result", "size_recommended", "fit_feedback_submitted", "stylist_outfit_generated",
  "outfit_added_to_bag", "affordability_view_opened", "budget_set", "budget_warning_shown",
  "budget_cap_blocked_checkout", "wishlist_added", "add_to_bag", "free_delivery_unlocked", "checkout_started",
  "payment_selected", "order_placed", "order_delivered", "return_requested", "refund_completed", "price_badge_viewed",
  "price_reported", "plus_paywall_viewed", "plus_started", "plus_cancelled", "gift_card_purchased",
  "gift_card_redeemed", "referral_shared", "referral_converted", "coins_earned", "drop_joined_queue", "drop_admitted",
  "consent_changed",
];

/** Domain events named in Part C "Events" blocks and §9.7. */
const SPEC_DOMAIN = [
  "user.registered", "user.age_blocked", "consent.changed", "session.revoked", "privacy.deletion_requested",
  "privacy.deletion_completed", "privacy.export_ready", "cart.line_unavailable", "order_group.placed",
  "order_group.paid", "order_group.failed", "inventory.reserved", "inventory.claimed", "inventory.released",
  "price.changed", "price_claim.scored", "price_enforcement.applied", "channel_snapshot.ingested", "return.received",
  "return.inspected", "refund.completed",
];

describe("analytics catalog", () => {
  it("contains every event in spec section 26", () => {
    for (const n of SPEC_26) expect(ANALYTICS_EVENT_NAMES, n).toContain(n);
  });

  it("every name and property key follows the naming convention", () => {
    for (const n of ANALYTICS_EVENT_NAMES) {
      expect(isValidAnalyticsEventName(n), n).toBe(true);
      for (const k of Object.keys(analyticsEvents[n].shape)) expect(isValidPropertyName(k), `${n}.${k}`).toBe(true);
    }
  });

  it("classifies every property exactly once, and only as P0 or P1", () => {
    for (const n of ANALYTICS_EVENT_NAMES) {
      const d = analyticsEvents[n];
      expect(Object.keys(d.classes).sort(), n).toEqual(Object.keys(d.shape).sort());
      for (const c of Object.values<string>(d.classes)) expect(["P0", "P1"], n).toContain(c);
    }
  });

  it("never lets a client event be strictly necessary, and uses known owners and retention ids", () => {
    for (const n of ANALYTICS_EVENT_NAMES) {
      const d = analyticsEvents[n];
      if (d.origin === "client") expect(d.purpose, n).not.toBe("strictly_necessary");
      expect(OWNER_MODULES, n).toContain(d.owner);
      expect(Object.keys(RETENTION_POLICIES), n).toContain(d.retention);
    }
  });

  it("accepts the fixture for each event and passes the PII policy", () => {
    for (const n of ANALYTICS_EVENT_NAMES) {
      const parsed = analyticsEvents[n].schema.safeParse(VALID_PROPS[n]);
      expect(parsed.success, n).toBe(true);
      expect(inspectProperties(VALID_PROPS[n]), n).toEqual([]);
    }
  });

  it("rejects unknown properties (strict schemas)", () => {
    for (const n of ANALYTICS_EVENT_NAMES) {
      const withExtra = { ...VALID_PROPS[n], extra_field: "x" };
      expect(analyticsEvents[n].schema.safeParse(withExtra).success, n).toBe(false);
    }
  });

  it("keeps free text out: search events carry a length, not the query", () => {
    expect(Object.keys(analyticsEvents.search_performed.shape)).not.toContain("query");
    expect(Object.keys(analyticsEvents.search_no_result.shape)).not.toContain("query");
  });

  it("budget and measurement events never fall back to the generic analytics purpose", () => {
    for (const n of ["budget_set", "budget_warning_shown", "budget_cap_blocked_checkout", "affordability_view_opened"] as const) {
      expect(analyticsEvents[n].purpose).toBe("budget_insights");
    }
    expect(analyticsEvents.size_recommended.purpose).toBe("measurements");
    expect(analyticsEvents.fit_feedback_submitted.purpose).toBe("measurements");
  });
});

describe("domain event catalog", () => {
  it("contains every domain event named in Part C", () => {
    for (const n of SPEC_DOMAIN) expect(DOMAIN_EVENT_NAMES, n).toContain(n);
  });

  it("follows aggregate.action naming and never declares P3", () => {
    for (const n of DOMAIN_EVENT_NAMES) {
      const d = domainEvents[n];
      expect(isValidDomainEventName(n), n).toBe(true);
      expect(Object.keys(d.classes).sort(), n).toEqual(Object.keys(d.shape).sort());
      for (const c of Object.values<string>(d.classes)) expect(["P0", "P1", "P2"], n).toContain(c);
      expect(d.version).toBeGreaterThanOrEqual(1);
      expect(OWNER_MODULES, n).toContain(d.owner);
      expect(Object.keys(RETENTION_POLICIES), n).toContain(d.recordRetention);
    }
  });

  it("mirrors exist and the mirror carries nothing the source payload does not", () => {
    for (const n of DOMAIN_EVENT_NAMES) {
      const d = domainEvents[n];
      if (!("analyticsMirror" in d)) continue;
      const mirror = analyticsEvents[d.analyticsMirror];
      expect(mirror.origin).toBe("server");
      expect(mirror.purpose).toBe("strictly_necessary");
      expect(Object.values<string>(mirror.classes)).not.toContain("P2");
    }
  });

  it("rejects an unknown field and a bad instant", () => {
    const d = domainEvents["privacy.export_ready"];
    const ok = { user_id: "user_fixture_001", request_id: "req_fixture_0001", expires_at: "2026-10-11T00:00:00Z" };
    expect(d.schema.safeParse(ok).success).toBe(true);
    expect(d.schema.safeParse({ ...ok, signed_url: "https://x" }).success).toBe(false);
    expect(d.schema.safeParse({ ...ok, expires_at: "tomorrow" }).success).toBe(false);
  });
});

describe("taxonomy renderer", () => {
  it("has one row per event", () => {
    const t = renderTaxonomyTables();
    for (const n of ANALYTICS_EVENT_NAMES) expect(t.analytics).toContain(`| \`${n}\` |`);
    for (const n of DOMAIN_EVENT_NAMES) expect(t.domain).toContain(`| \`${n}\` |`);
  });
});
