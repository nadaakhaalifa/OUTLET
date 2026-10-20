/**
 * Source guard for owner rule R0 (ADR-0055, spec section 13): a guest is asked to create an account only at the Checkout
 * gate. No file under apps/mobile/src outside the allow-list may name the sign-up or account-creation routes, import the
 * account-creation screen or use its copy. (The import side is enforced by dependency-cruiser `no-sign-up-outside-gate`.)
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..", "..");
const FORBIDDEN = /\/sign-up\b|\/onboarding\/(?:account|consents|otp)\b|AccountCreate|\bsignUp\.|onboarding\.account\./;

/** Folders and files that may name the routes: the gate, its route, the onboarding routes, the hosted screen, tests. */
const ALLOWED: readonly RegExp[] = [
  /^features\/checkout-gate\//,
  /^app\/sign-up\.tsx$/,
  /^app\/onboarding\//,
  /^features\/account-creation\//,
  /\.test\.tsx?$/,
  /^features\/flow\.ts$/, // the onboarding route map (ROUTE_FOR_STEP); no shopper surface reads it
];

/**
 * Legacy first-launch files that still send a signed-out shopper to the onboarding routes. WP-G3 rewrites them
 * (resolveEntry, role screen) and MUST delete these entries: the test below fails if an entry no longer matches.
 */
const PENDING_G3: readonly string[] = [];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}
const files = walk(SRC).map((p) => ({ rel: relative(SRC, p).split(sep).join("/"), text: readFileSync(p, "utf8") }));

describe("R0 source guard", () => {
  it("scans the app", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it("no file outside the allow-list names a sign-up or account-creation route, import or string", () => {
    const offenders = files
      .filter((f) => !ALLOWED.some((a) => a.test(f.rel)) && !PENDING_G3.includes(f.rel) && FORBIDDEN.test(f.text))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("the pending-G3 list only holds files that still need it", () => {
    const stale = PENDING_G3.filter((rel) => !FORBIDDEN.test(files.find((f) => f.rel === rel)?.text ?? ""));
    expect(stale).toEqual([]);
  });

  it("the Bag is the only shopper screen that opens the gate, and only through the gate index", () => {
    const users = files.filter((f) => !/^features\/checkout-gate\//.test(f.rel) && !/\.test\.tsx?$/.test(f.rel) && /from "[^"]*checkout-gate/.test(f.text)).map((f) => f.rel);
    expect(users.sort()).toEqual(["app/onboarding/_layout.tsx", "app/sign-up.tsx", "features/bag/BagScreen.tsx"]);
    const bag = files.find((f) => f.rel === "features/bag/BagScreen.tsx")?.text ?? "";
    expect(bag).toMatch(/from "\.\.\/checkout-gate"/);
    expect(bag).not.toMatch(/checkout-gate\/(?!index)/);
  });

  it("the Bag screen offers no sign-up prompt of its own", () => {
    const bag = files.find((f) => f.rel === "features/bag/BagScreen.tsx")?.text ?? "";
    expect(bag).not.toMatch(/account|sign.?up|onboarding/i);
  });
});
