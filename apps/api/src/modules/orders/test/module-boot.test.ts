import { describe, expect, it } from "vitest";
import { loadConfig } from "../../../config/env";
import { NoProductionAdaptersError } from "../../../platform/platform.module";
import { InMemoryOrderRepository } from "../adapters/in-memory";
import { MissingOrdersPortsError, OrdersModule } from "../orders.module";
import { TestClock } from "./fixtures";

describe("OrdersModule.forRoot", () => {
  it("boots with in-memory fixtures in test mode", () => {
    expect(() => OrdersModule.forRoot(loadConfig({ NODE_ENV: "test" }))).not.toThrow();
  });

  it("refuses production adapters without a real repository", () => {
    const cfg = { ...loadConfig({ NODE_ENV: "test" }), adapters: "postgres" } as unknown as ReturnType<typeof loadConfig>;
    expect(() => OrdersModule.forRoot(cfg)).toThrow(NoProductionAdaptersError);
  });

  it("refuses a missing store directory outside test mode", () => {
    const cfg = { ...loadConfig({ NODE_ENV: "test" }), adapters: "postgres" } as unknown as ReturnType<typeof loadConfig>;
    const repo = new InMemoryOrderRepository(new TestClock(), () => "00000000-0000-4000-8000-000000000001");
    expect(() => OrdersModule.forRoot(cfg, { repository: repo })).toThrow(MissingOrdersPortsError);
  });
});
