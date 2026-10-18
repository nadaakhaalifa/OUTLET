import { describe, expect, it } from "vitest";
import { loadConfig } from "../../../config/env";
import { NoProductionAdaptersError } from "../../../platform/platform.module";
import { InMemoryForecastStore, StaticForecastFlags } from "../adapters/in-memory";
import { ForecastingModule, MissingForecastingPortsError } from "../forecasting.module";

describe("ForecastingModule.forRoot boot guard", () => {
  const dev = loadConfig({ NODE_ENV: "development" });
  it("refuses to boot outside test mode without real flags", () => {
    expect(() => ForecastingModule.forRoot(dev)).toThrow(MissingForecastingPortsError);
  });
  it("boots with flags, and in test mode with fixtures", () => {
    expect(() => ForecastingModule.forRoot(dev, { flags: new StaticForecastFlags() })).not.toThrow();
    expect(() => ForecastingModule.forRoot(loadConfig({ NODE_ENV: "test" }))).not.toThrow();
  });
  it("production mode requires a real store", () => {
    const prod = { ...loadConfig({ NODE_ENV: "test" }), adapters: "production" as const };
    expect(() => ForecastingModule.forRoot(prod)).toThrow(NoProductionAdaptersError);
    expect(() => ForecastingModule.forRoot(prod, { store: new InMemoryForecastStore() })).toThrow(MissingForecastingPortsError);
  });
});
