import { describe, expect, it } from "vitest";
import { spikeEnabled } from "./gate";

describe("spikeEnabled", () => {
  it("is on outside production", () => {
    expect(spikeEnabled({ NODE_ENV: "development" })).toBe(true);
    expect(spikeEnabled({ NODE_ENV: "test" })).toBe(true);
  });
  it("fails closed for undefined, unknown and differently cased NODE_ENV", () => {
    for (const NODE_ENV of [undefined, "", "staging", "prod", "Production", "Development", "preview"]) {
      expect(spikeEnabled({ NODE_ENV }), String(NODE_ENV)).toBe(false);
      expect(spikeEnabled({ NODE_ENV, ADMIN_CHART_SPIKE: "true" }), `${String(NODE_ENV)}+true`).toBe(false);
      expect(spikeEnabled({ NODE_ENV, ADMIN_CHART_SPIKE: "1" }), `${String(NODE_ENV)}+1`).toBe(true);
    }
    expect(spikeEnabled({})).toBe(false);
  });
  it("is off in production unless the flag is exactly 1", () => {
    expect(spikeEnabled({ NODE_ENV: "production" })).toBe(false);
    expect(spikeEnabled({ NODE_ENV: "production", ADMIN_CHART_SPIKE: "true" })).toBe(false);
    expect(spikeEnabled({ NODE_ENV: "production", ADMIN_CHART_SPIKE: "1" })).toBe(true);
  });
});
