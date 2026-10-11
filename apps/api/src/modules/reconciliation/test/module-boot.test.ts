import { describe, expect, it } from "vitest";
import { loadConfig } from "../../../config/env";
import { NoProductionAdaptersError } from "../../../platform/platform.module";
import { InMemoryReconStore } from "../adapters/in-memory";
import { MissingReconciliationPortsError, ReconciliationModule } from "../reconciliation.module";

describe("ReconciliationModule.forRoot", () => {
  const production = () => ({ ...loadConfig({ NODE_ENV: "test" }), adapters: "postgres" }) as unknown as ReturnType<typeof loadConfig>;

  it("boots with fakes in test mode", () => {
    expect(() => ReconciliationModule.forRoot(loadConfig({ NODE_ENV: "test" }))).not.toThrow();
  });
  it("refuses production adapters without a real store", () => {
    expect(() => ReconciliationModule.forRoot(production())).toThrow(NoProductionAdaptersError);
  });
  it("refuses to boot outside test mode with fake sources", () => {
    try {
      ReconciliationModule.forRoot(production(), { store: new InMemoryReconStore() });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(MissingReconciliationPortsError);
      expect((e as MissingReconciliationPortsError).missing).toHaveLength(5);
    }
  });
});
