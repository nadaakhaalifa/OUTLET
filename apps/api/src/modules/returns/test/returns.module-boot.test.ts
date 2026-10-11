import { describe, expect, it } from "vitest";
import { loadConfig } from "../../../config/env";
import { NoProductionAdaptersError } from "../../../platform/platform.module";
import {
  FakeEvidence,
  FakeExchangeStock,
  FakeReturnableLines,
  InMemoryReturnEventPublisher,
  InMemoryReturnRepository,
  StaticReturnerHistory,
  StaticReturnsMembership,
} from "../adapters/in-memory";
import { MissingReturnsPortsError, ReturnsModule } from "../returns.module";

describe("ReturnsModule.forRoot boot guard", () => {
  const dev = loadConfig({ NODE_ENV: "development" });
  const all = {
    lines: new FakeReturnableLines(),
    membership: new StaticReturnsMembership(),
    history: new StaticReturnerHistory(),
    evidence: new FakeEvidence(),
    exchangeStock: new FakeExchangeStock(),
    events: new InMemoryReturnEventPublisher(),
  };

  it("throws outside test mode when no real ports are supplied, naming every one", () => {
    try {
      ReturnsModule.forRoot(dev);
      throw new Error("should not boot");
    } catch (e) {
      expect(e).toBeInstanceOf(MissingReturnsPortsError);
      expect((e as MissingReturnsPortsError).missing).toHaveLength(6);
    }
  });

  it("names exactly what is missing", () => {
    const { evidence: _e, ...rest } = all;
    try {
      ReturnsModule.forRoot(dev, rest);
      throw new Error("should not boot");
    } catch (e) {
      expect((e as MissingReturnsPortsError).missing).toHaveLength(1);
      expect((e as Error).message).toMatch(/evidence/);
    }
  });

  it("boots when every port is supplied, and in test mode with fixtures", () => {
    expect(() => ReturnsModule.forRoot(dev, all)).not.toThrow();
    expect(() => ReturnsModule.forRoot(loadConfig({ NODE_ENV: "test" }))).not.toThrow();
  });

  it("in production mode requires a real repository and the money-adjacent ports", () => {
    const prod = { ...loadConfig({ NODE_ENV: "test" }), adapters: "production" as const };
    expect(() => ReturnsModule.forRoot(prod)).toThrow(NoProductionAdaptersError);
    expect(() => ReturnsModule.forRoot(prod, { repository: new InMemoryReturnRepository() })).toThrow(
      MissingReturnsPortsError,
    );
  });
});
