import { describe, expect, it } from "vitest";
import { loadConfig } from "../../../config/env";
import { FulfillmentModule, MissingFulfillmentPortsError } from "../index";
import { InMemoryFulfillmentRepository } from "../adapters/in-memory";

describe("FulfillmentModule.forRoot", () => {
  it("boots in test mode with fixtures", () => {
    expect(() => FulfillmentModule.forRoot(loadConfig({ NODE_ENV: "test" }))).not.toThrow();
  });

  it("refuses to boot outside test mode without real courier ports", () => {
    const cfg = loadConfig({ NODE_ENV: "development" });
    expect(() => FulfillmentModule.forRoot(cfg, { repository: new InMemoryFulfillmentRepository() })).toThrow(
      MissingFulfillmentPortsError,
    );
  });
});
