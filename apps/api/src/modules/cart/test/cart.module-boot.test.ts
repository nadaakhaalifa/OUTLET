import { describe, expect, it } from "vitest";
import { loadConfig } from "../../../config/env";
import { CartModule, MissingCartPortsError } from "../cart.module";
import { FakeCatalog } from "../adapters/fake-catalog";
import { InMemoryCartRepository, StaticMembership, StaticPlatformConfig } from "../adapters/in-memory";
import { NoProductionAdaptersError } from "../../../platform/platform.module";

describe("CartModule.forRoot boot guard", () => {
  const dev = loadConfig({ NODE_ENV: "development" });

  it("throws outside test mode when no real ports are supplied", () => {
    expect(() => CartModule.forRoot(dev)).toThrow(MissingCartPortsError);
    try {
      CartModule.forRoot(dev);
    } catch (e) {
      expect((e as MissingCartPortsError).missing).toHaveLength(3);
    }
  });

  it("names exactly what is missing", () => {
    const err = (() => {
      try {
        CartModule.forRoot(dev, { catalog: new FakeCatalog(), membership: new StaticMembership() });
      } catch (e) {
        return e as MissingCartPortsError;
      }
      return null;
    })();
    expect(err?.missing).toHaveLength(1);
    expect(err?.message).toMatch(/platformConfig/);
  });

  it("boots when every port is supplied, and in test mode with fixtures", () => {
    expect(() =>
      CartModule.forRoot(dev, {
        catalog: new FakeCatalog(),
        membership: new StaticMembership(),
        platformConfig: new StaticPlatformConfig(),
      }),
    ).not.toThrow();
    expect(() => CartModule.forRoot(loadConfig({ NODE_ENV: "test" }))).not.toThrow();
  });

  it("in production mode refuses missing money ports even when a repository is supplied", () => {
    const prod = { ...loadConfig({ NODE_ENV: "test" }), adapters: "production" as const };
    expect(() => CartModule.forRoot(prod)).toThrow(NoProductionAdaptersError);
    expect(() => CartModule.forRoot(prod, { repository: new InMemoryCartRepository() })).toThrow(MissingCartPortsError);
  });
});
