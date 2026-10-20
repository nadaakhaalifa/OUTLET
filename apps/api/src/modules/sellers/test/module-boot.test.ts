import { describe, expect, it } from "vitest";
import { loadConfig } from "../../../config/env";
import { NoProductionAdaptersError } from "../../../platform/platform.module";
import { InMemoryBrandApplicationRepository } from "../adapters/in-memory";
import { SellersModule } from "../sellers.module";

const prod = { ...loadConfig({ NODE_ENV: "test" }), adapters: "postgres" } as unknown as ReturnType<typeof loadConfig>;

describe("SellersModule.forRoot", () => {
  it("boots with in-memory fixtures in test mode", () => {
    expect(() => SellersModule.forRoot(loadConfig({ NODE_ENV: "test" }))).not.toThrow();
  });
  it("refuses production adapters unless every real port is supplied", () => {
    expect(() => SellersModule.forRoot(prod)).toThrow(NoProductionAdaptersError);
    expect(() => SellersModule.forRoot(prod, { repository: new InMemoryBrandApplicationRepository() })).toThrow(NoProductionAdaptersError);
  });
});
