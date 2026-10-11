import { describe, expect, it } from "vitest";
import { loadConfig } from "../../../config/env";
import { NoProductionAdaptersError } from "../../../platform/platform.module";
import { InMemoryAnalyticsStore, InMemoryAudit, InMemoryEventSource, StaticProductStoreLookup } from "../adapters/in-memory";
import { MissingSellerAnalyticsPortsError, SellerAnalyticsModule } from "../seller-analytics.module";

describe("SellerAnalyticsModule.forRoot boot guard", () => {
  const dev = loadConfig({ NODE_ENV: "development" });
  const all = { audit: new InMemoryAudit(), source: new InMemoryEventSource(), productStore: new StaticProductStoreLookup() };

  it("refuses to boot outside test mode without a real audit port, source and lookup", () => {
    try {
      SellerAnalyticsModule.forRoot(dev);
      throw new Error("should not boot");
    } catch (e) {
      expect(e).toBeInstanceOf(MissingSellerAnalyticsPortsError);
      expect((e as MissingSellerAnalyticsPortsError).missing).toHaveLength(3);
      expect((e as Error).message).toMatch(/audit/);
    }
  });
  it("boots with every port, and in test mode with fixtures", () => {
    expect(() => SellerAnalyticsModule.forRoot(dev, all)).not.toThrow();
    expect(() => SellerAnalyticsModule.forRoot(loadConfig({ NODE_ENV: "test" }))).not.toThrow();
  });
  it("production mode requires a real store", () => {
    const prod = { ...loadConfig({ NODE_ENV: "test" }), adapters: "production" as const };
    expect(() => SellerAnalyticsModule.forRoot(prod)).toThrow(NoProductionAdaptersError);
    expect(() => SellerAnalyticsModule.forRoot(prod, { store: new InMemoryAnalyticsStore() })).toThrow(MissingSellerAnalyticsPortsError);
  });
});
