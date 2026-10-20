import { describe, expect, it } from "vitest";
import { GUEST_FEATURES, GUEST_ROUTES, GUEST_RULES, guestBehaviour, type GuestKind } from "./capabilities";

describe("guest behaviour table (spec section 2)", () => {
  const expected: Readonly<Record<string, GuestKind>> = {
    orders: "empty", returns: "empty", wallet: "hidden", rewards: "hidden", giftCards: "deferred", plus: "deferred", referral: "deferred",
    reviewWrite: "hidden", notifications: "deferred", sizeProfile: "local", priceAlerts: "local", savedSearchAlerts: "hidden", shareLists: "hidden",
    budget: "deferred", stylist: "deferred", stylistChat: "deferred", visualSearch: "deferred", nlSearch: "deferred", drops: "empty",
    addresses: "hidden", sessions: "hidden", accountDeletion: "hidden", serverPrivacy: "hidden", checkout: "deferred",
  };
  it.each(Object.entries(expected))("%s -> %s", (f, k) => {
    expect(guestBehaviour(f as (typeof GUEST_FEATURES)[number])).toBe(k);
  });
  it("classifies every feature with one of the four kinds", () => {
    for (const f of GUEST_FEATURES) expect(["hidden", "empty", "local", "deferred"]).toContain(GUEST_RULES[f].kind);
  });
  it("every guarded route maps to a classified feature", () => {
    for (const f of Object.values(GUEST_ROUTES)) expect(GUEST_FEATURES).toContain(f);
  });
  it("every Me-reachable account route is guarded", () => {
    for (const r of ["/addresses", "/auto-buy", "/returns", "/outfit-calendar", "/wardrobe"] as const) expect(GUEST_ROUTES).toHaveProperty([r]);
  });
  it("only features with a guest screen are opened as screens: hidden and deferred never open", () => {
    for (const f of GUEST_FEATURES) {
      const r = GUEST_RULES[f];
      if (r.kind === "hidden") expect(r.entry).toBe(false);
    }
    expect(GUEST_RULES.plus.screen).toBe(true);
    expect(GUEST_RULES.orders.screen).toBe(false);
  });
});
