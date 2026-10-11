import { describe, expect, it } from "vitest";
import { loadConfig } from "../../../config/env";
import { NoProductionAdaptersError } from "../../../platform/platform.module";
import { CheckoutModule, MissingCheckoutPortsError } from "../checkout.module";
import { InMemorySagaRepository } from "../adapters/in-memory";

describe("CheckoutModule.forRoot", () => {
  it("boots with fakes in test mode", () => {
    expect(() => CheckoutModule.forRoot(loadConfig({ NODE_ENV: "test" }))).not.toThrow();
  });

  it("refuses production without a repository, and non-test mode without real ports", () => {
    const dev = loadConfig({ NODE_ENV: "development" });
    expect(() => CheckoutModule.forRoot(dev, { repository: new InMemorySagaRepository() })).toThrow(MissingCheckoutPortsError);
    const prodLike = { ...loadConfig({ NODE_ENV: "test" }), adapters: "postgres" } as unknown as ReturnType<typeof loadConfig>;
    expect(() => CheckoutModule.forRoot(prodLike)).toThrow(NoProductionAdaptersError);
  });
});
