import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APP_FEATURE_KEYS, ENTITLEMENT_GROUPS, entitlementGrants } from "./domain/bridge";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules") continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** ADR-0004 Plan A: the stylist is free with fair use for everyone and never reads Plus. */
describe("Plan A contract (ADR-0004)", () => {
  it("app_features is reserved and empty, every grant is a commerce benefit", () => {
    expect(ENTITLEMENT_GROUPS).toEqual(["commerce_benefits", "app_features"]);
    expect(APP_FEATURE_KEYS).toHaveLength(0);
    expect(entitlementGrants().every((g) => g.group === "commerce_benefits")).toBe(true);
  });

  it("no stylist or ai-stylist code imports the subscriptions module or reads entitlements", () => {
    const stylistFiles = walk(SRC).filter((f) => /[\\/](stylist|ai-stylist)[\\/]/i.test(f) && !f.endsWith(".test.ts"));
    for (const f of stylistFiles) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/modules\/subscriptions|PLUS_ENTITLEMENTS|PlusEntitlements|app_features/);
    }
  });
});
