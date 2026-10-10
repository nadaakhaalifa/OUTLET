import { describe, expect, it } from "vitest";
import { loadConfig } from "../../../config/env";
import { NoProductionAdaptersError } from "../../../platform/platform.module";
import {
  FakeProductFacts,
  InMemorySavedSearchRepository,
  InMemorySearchIndex,
  InMemorySuggestionDirectory,
  StaticShopperScope,
} from "../adapters/in-memory";
import { MissingSearchPortsError, SearchModule } from "../search.module";

describe("SearchModule.forRoot boot guard", () => {
  const dev = loadConfig({ NODE_ENV: "development" });
  const all = {
    fallback: new InMemorySearchIndex(),
    facts: new FakeProductFacts(),
    savedSearches: new InMemorySavedSearchRepository(),
    scope: new StaticShopperScope(),
    directory: new InMemorySuggestionDirectory(),
  };

  it("throws outside test mode when no real ports are supplied", () => {
    expect(() => SearchModule.forRoot(dev)).toThrow(MissingSearchPortsError);
    try {
      SearchModule.forRoot(dev);
    } catch (e) {
      expect((e as MissingSearchPortsError).missing).toHaveLength(5);
    }
  });

  it("names exactly what is missing", () => {
    const { facts: _f, ...rest } = all;
    try {
      SearchModule.forRoot(dev, rest);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as MissingSearchPortsError).missing).toHaveLength(1);
      expect((e as Error).message).toMatch(/facts/);
    }
  });

  it("boots when every port is supplied, and in test mode with fixtures", () => {
    expect(() => SearchModule.forRoot(dev, all)).not.toThrow();
    expect(() => SearchModule.forRoot(loadConfig({ NODE_ENV: "test" }))).not.toThrow();
  });

  it("in production mode refuses a missing repository and missing live ports", () => {
    const prod = { ...loadConfig({ NODE_ENV: "test" }), adapters: "production" as const };
    expect(() => SearchModule.forRoot(prod)).toThrow(NoProductionAdaptersError);
    expect(() => SearchModule.forRoot(prod, { savedSearches: new InMemorySavedSearchRepository() })).toThrow(
      MissingSearchPortsError,
    );
  });
});
