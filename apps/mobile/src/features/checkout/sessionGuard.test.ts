import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveCheckoutAccess } from "./sessionAccess";

const deps = (s: boolean, o: boolean) => ({ hasSession: async () => s, isOnboardingDone: async () => o });

describe("checkout session guard", () => {
  it("allows only a session with finished onboarding", async () => {
    expect(await resolveCheckoutAccess(deps(true, true))).toBe(true);
    expect(await resolveCheckoutAccess(deps(true, false))).toBe(false);
    expect(await resolveCheckoutAccess(deps(false, true))).toBe(false);
    expect(await resolveCheckoutAccess(deps(false, false))).toBe(false);
  });
  it("does not check onboarding for a guest", async () => {
    let asked = false;
    await resolveCheckoutAccess({ hasSession: async () => false, isOnboardingDone: async () => { asked = true; return true; } });
    expect(asked).toBe(false);
  });
  it("the checkout layout uses the guard, renders nothing until allowed, and redirects to the Bag only", () => {
    const layout = readFileSync(join(__dirname, "..", "..", "app", "checkout", "_layout.tsx"), "utf8");
    expect(layout).toMatch(/useCheckoutSessionGuard\(\)/);
    expect(layout).toMatch(/if \(!allowed\) return null/);
    const guard = readFileSync(join(__dirname, "sessionGuard.ts"), "utf8");
    expect(guard).toContain("/(tabs)/bag");
    expect(guard).not.toMatch(/"\/(?:sign-up|onboarding)/);
  });
});
