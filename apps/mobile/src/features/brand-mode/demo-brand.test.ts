import { describe, expect, it } from "vitest";
import { createDemoBrandPort, demoBrandPortIfAllowed, demoSeed } from "./demo-brand";
import { trendBars, verifiedOffPct } from "./dashboardModel";
import { isDemoBrandAllowed, resolveBackendConfig } from "../../services/release-guard";

const NOW = 1_800_000_000_000;

describe("demo brand release guard", () => {
  it("is allowed only in a dev build on the fixture backend", () => {
    expect(isDemoBrandAllowed(resolveBackendConfig("", true), true)).toBe(true);
  });
  it("is blocked in every release configuration", () => {
    expect(isDemoBrandAllowed(resolveBackendConfig("", false), false)).toBe(false); // blocked: missing
    expect(isDemoBrandAllowed(resolveBackendConfig("https://api.z-outlet.example", false), false)).toBe(false);
    expect(isDemoBrandAllowed(resolveBackendConfig("https://REPLACE-ME.invalid", false), false)).toBe(false);
    // even if the fixture config were somehow produced, a non-dev flag still denies
    expect(isDemoBrandAllowed({ kind: "fixture" }, false)).toBe(false);
  });
  it("is blocked in dev when a real API is configured", () => {
    expect(isDemoBrandAllowed(resolveBackendConfig("http://localhost:3000", true), true)).toBe(false);
  });
  it("never constructs the demo port when disallowed", () => {
    expect(demoBrandPortIfAllowed({ kind: "blocked", reason: "missing" }, false, () => NOW)).toBeNull();
    expect(demoBrandPortIfAllowed({ kind: "api", baseUrl: "https://x.example" }, true, () => NOW)).toBeNull();
    expect(demoBrandPortIfAllowed({ kind: "fixture" }, false, () => NOW)).toBeNull();
    expect(demoBrandPortIfAllowed({ kind: "fixture" }, true, () => NOW)).not.toBeNull();
  });
});

describe("demo brand data", () => {
  const seed = demoSeed(NOW);
  it("seeds Nile Outlet with 12 products incl. one low-stock, one paused, one draft", () => {
    expect(seed.account.name.en).toBe("Nile Outlet");
    expect(seed.products).toHaveLength(12);
    expect(seed.products.filter((p) => p.status === "paused")).toHaveLength(1);
    expect(seed.products.filter((p) => p.status === "active" && p.totalStock <= 3)).toHaveLength(1);
  });
  it("attaches a reference price only to verified discounts, always above the price", () => {
    for (const p of seed.products) {
      if (p.claim === "verified_discount") { expect(p.referencePrice).toBeGreaterThan(p.priceFrom ?? 0n); expect(verifiedOffPct(p.claim, p.priceFrom, p.referencePrice)).not.toBeNull(); }
      else { expect(p.referencePrice ?? null).toBeNull(); expect(verifiedOffPct(p.claim, p.priceFrom, p.referencePrice)).toBeNull(); }
    }
  });
  it("has six orders in six different states and a populated dashboard", async () => {
    expect(new Set(seed.orders.map((o) => o.status)).size).toBe(6);
    const d = await createDemoBrandPort(() => NOW).dashboard();
    expect(d.awaiting.length).toBe(2);
    expect(d.payout.available).toBe(412_500n);
    expect(d.inTransit).toBe(226_000n);
    expect(d.trust.score).toBe(82);
    expect(d.plan?.name.en).toBe("Growth");
    expect(d.salesTrend).toHaveLength(7);
  });
});

describe("dashboard helpers", () => {
  it("trendBars is null without an honest series", () => {
    expect(trendBars(undefined)).toBeNull();
    expect(trendBars([5n])).toBeNull();
    expect(trendBars([0n, 0n, 0n])).toBeNull();
  });
  it("trendBars normalises to the max", () => {
    expect(trendBars([50n, 100n])).toEqual([0.5, 1]);
  });
  it("verifiedOffPct floors on integers and needs >= 5%", () => {
    expect(verifiedOffPct("verified_discount", 129_000n, 189_000n)).toBe(31);
    expect(verifiedOffPct("verified_discount", 98_000n, 100_000n)).toBeNull();
    expect(verifiedOffPct("launch_price", 1n, 100n)).toBeNull();
    expect(verifiedOffPct("verified_discount", 100n, null)).toBeNull();
  });
});
