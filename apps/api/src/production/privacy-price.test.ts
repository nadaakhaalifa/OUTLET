import { describe, expect, it } from "vitest";
import { MODULE_BINDINGS } from "./bindings";

describe("production registry rows for privacy and price-integrity", () => {
  it("both modules are composed (real Kysely stores; only the KMS cipher and object store are external)", () => {
    expect(MODULE_BINDINGS.privacy).toEqual({ status: "composed" });
    expect(MODULE_BINDINGS["price-integrity"]).toEqual({ status: "composed" });
  });
});
