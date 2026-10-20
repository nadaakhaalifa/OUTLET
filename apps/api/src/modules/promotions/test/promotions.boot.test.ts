import { describe, expect, it } from "vitest";
import { loadConfig } from "../../../config/env";
import { NoProductionAdaptersError } from "../../../platform/platform.module";
import {
  DenyAllServiceAuthenticator,
  InMemoryPromotionRepository,
  StaticServiceTokenAuthenticator,
} from "../adapters/in-memory";
import { MissingPromotionsPortsError, PromotionsModule } from "../promotions.module";

describe("PromotionsModule.forRoot boot guard", () => {
  const dev = loadConfig({ NODE_ENV: "development" });

  it("refuses to run outside test mode without a service authenticator", () => {
    expect(() => PromotionsModule.forRoot(dev)).toThrow(MissingPromotionsPortsError);
    try {
      PromotionsModule.forRoot(dev);
    } catch (e) {
      expect((e as MissingPromotionsPortsError).missing[0]).toMatch(/serviceAuth/);
    }
  });

  it("boots when the service authenticator is supplied, and in test mode with fixtures", () => {
    expect(() =>
      PromotionsModule.forRoot(dev, { serviceAuth: new StaticServiceTokenAuthenticator("x".repeat(32)) }),
    ).not.toThrow();
    expect(() => PromotionsModule.forRoot(loadConfig({ NODE_ENV: "test" }))).not.toThrow();
  });

  it("in production mode refuses a missing repository first, then a missing authenticator", () => {
    const prod = { ...loadConfig({ NODE_ENV: "test" }), adapters: "production" as const };
    expect(() => PromotionsModule.forRoot(prod)).toThrow(NoProductionAdaptersError);
    expect(() => PromotionsModule.forRoot(prod, { repository: new InMemoryPromotionRepository() })).toThrow(
      MissingPromotionsPortsError,
    );
  });
});

describe("service authenticators", () => {
  it("accepts only the exact bearer token", () => {
    const a = new StaticServiceTokenAuthenticator("s".repeat(30));
    expect(a.verify(`Bearer ${"s".repeat(30)}`)).toBe(true);
    expect(a.verify(`Bearer ${"s".repeat(29)}`)).toBe(false);
    expect(a.verify(`Bearer ${"s".repeat(31)}`)).toBe(false);
    expect(a.verify("s".repeat(30))).toBe(false);
    expect(a.verify(undefined)).toBe(false);
    expect(a.verify("")).toBe(false);
  });
  it("rejects a short secret", () => {
    expect(() => new StaticServiceTokenAuthenticator("short")).toThrow(/at least 24/);
  });
  it("the default denies everyone", () => {
    expect(new DenyAllServiceAuthenticator().verify()).toBe(false);
  });
});
