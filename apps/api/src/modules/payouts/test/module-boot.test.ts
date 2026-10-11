import { describe, expect, it } from "vitest";
import { loadConfig } from "../../../config/env";
import { NoProductionAdaptersError } from "../../../platform/platform.module";
import { InMemoryPayoutStore } from "../adapters/in-memory";
import { MissingPayoutsPortsError, PayoutsModule } from "../payouts.module";
import { TestClock } from "./fixtures";

describe("PayoutsModule.forRoot", () => {
  const production = () => ({ ...loadConfig({ NODE_ENV: "test" }), adapters: "postgres" }) as unknown as ReturnType<typeof loadConfig>;

  it("boots with in-memory fakes in test mode", () => {
    expect(() => PayoutsModule.forRoot(loadConfig({ NODE_ENV: "test" }))).not.toThrow();
  });

  it("refuses production adapters without a real store", () => {
    expect(() => PayoutsModule.forRoot(production())).toThrow(NoProductionAdaptersError);
  });

  it("refuses to boot outside test mode with a fake on any money-moving port", () => {
    const store = new InMemoryPayoutStore(new TestClock());
    try {
      PayoutsModule.forRoot(production(), { store });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(MissingPayoutsPortsError);
      expect((e as MissingPayoutsPortsError).missing.length).toBe(7);
    }
  });
});
