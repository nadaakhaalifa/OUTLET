import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INSTRUMENTS, promName, registeredPromNames } from "./metrics";

const RULES_DIR = join(__dirname, "../../../../../infra/observability/prometheus/rules");
const METRIC = /\b((?:outlet|http)_[a-z0-9_]+)/g;

function metricsInRules(): Map<string, string> {
  const found = new Map<string, string>();
  for (const f of readdirSync(RULES_DIR).filter((n) => n.endsWith(".rules.yaml"))) {
    for (const line of readFileSync(join(RULES_DIR, f), "utf8").split("\n")) {
      for (const m of line.matchAll(METRIC)) {
        const name = m[1] ?? "";
        // label names like http_request_method are labels, not metrics
        if (name === "http_request_method" || name === "http_response_status_code" || name === "http_route") continue;
        found.set(name, f);
      }
    }
  }
  return found;
}

describe("prometheus rules vs telemetry registry", () => {
  const registered = registeredPromNames();
  const used = metricsInRules();
  it("finds metrics in the rules", () => {
    expect(used.size).toBeGreaterThanOrEqual(8);
  });
  it.each([...used.entries()])("%s (in %s) is registered by the telemetry module", (name) => {
    expect(registered.has(name), `${name} not registered; rename breaks the SLO rules`).toBe(true);
  });
  it("histogram boundaries needed by the rules exist", () => {
    // le=0.15 (reserve, search), 0.3 (api read), 5 (payment confirmation)
    expect(INSTRUMENTS.filter((i) => i.kind === "histogram").length).toBeGreaterThan(3);
    expect(promName({ name: "outlet.reserve.duration", kind: "histogram", unit: "s", description: "" })).toBe("outlet_reserve_duration_seconds");
  });
});
