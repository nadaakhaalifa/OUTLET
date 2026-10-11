import { describe, expect, it } from "vitest";
import { PLUS_CANCEL_TAPS_FROM_ME, TABS, visibleMeRows } from "./model";

describe("tabs", () => {
  it("are Home, Explore, Stylist, Bag, Me in that logical order", () => {
    expect(TABS.map((t) => t.id)).toEqual(["home", "explore", "stylist", "bag", "me"]);
  });
  it("have unique routes and test ids", () => {
    expect(new Set(TABS.map((t) => t.route)).size).toBe(TABS.length);
    expect(new Set(TABS.map((t) => t.testID)).size).toBe(TABS.length);
  });
});

describe("Me rows", () => {
  const ids = (g: Parameters<typeof visibleMeRows>[0]) => visibleMeRows(g).map((r) => r.id);
  it("shows every row, gift cards included, when a capability is on", () => {
    expect(ids({ sales: true, redemption: false })).toEqual([
      "orders", "wallet", "budget", "wishlists", "sizeProfile", "plus", "rewards", "giftCards", "privacy", "help", "settings",
    ]);
    expect(ids({ sales: false, redemption: true })).toContain("giftCards");
  });
  it("hides gift cards when both kill switches are off or capabilities are unknown", () => {
    expect(ids({ sales: false, redemption: false })).not.toContain("giftCards");
    expect(ids(null)).not.toContain("giftCards");
    expect(ids(null)).toHaveLength(10);
  });
  it("keeps the rest of the menu when gift cards are hidden", () => {
    expect(ids(null)).toEqual(["orders", "wallet", "budget", "wishlists", "sizeProfile", "plus", "rewards", "privacy", "help", "settings"]);
  });
  it("has unique test ids and hrefs", () => {
    const rows = visibleMeRows({ sales: true, redemption: true });
    expect(new Set(rows.map((r) => r.testID)).size).toBe(rows.length);
    expect(new Set(rows.map((r) => r.href)).size).toBe(rows.length);
  });
  it("reaches Cancel Plus in at most two taps from Me", () => {
    expect(visibleMeRows(null).some((r) => r.id === "plus")).toBe(true);
    expect(PLUS_CANCEL_TAPS_FROM_ME).toBeLessThanOrEqual(2);
  });
  it("never lists the wallet as cash or money", () => {
    expect(visibleMeRows(null).find((r) => r.id === "wallet")?.titleKey).toBe("me.rows.wallet");
  });
});
