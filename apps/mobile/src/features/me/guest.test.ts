import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { groupedMeRows } from "../navigation/model";
import { guestMeRows } from "./guest-rows";
import { resolveGuestMode } from "./guest-mode";
import { guestStateCopy } from "./guest-states";
import { SELL_ROUTE, SIGN_IN_ROUTE } from "./routes";
import { GUEST_ROUTES, guestRule } from "../guest/capabilities";

describe("guest mode", () => {
  it("is a member offline (fixtures) and while signed in; guest only without tokens on a real backend", () => {
    expect(resolveGuestMode({ backendConfigured: false, hasTokens: null })).toBe("member");
    expect(resolveGuestMode({ backendConfigured: true, hasTokens: null })).toBe("unknown");
    expect(resolveGuestMode({ backendConfigured: true, hasTokens: false })).toBe("guest");
    expect(resolveGuestMode({ backendConfigured: true, hasTokens: true })).toBe("member");
  });
});

describe("Me rows for a guest", () => {
  const ids = guestMeRows(groupedMeRows(null).flat()).map((r) => r.id);
  it("keeps orders (empty state), wishlists, size profile, plus, privacy, help, settings", () => {
    for (const id of ["orders", "wishlists", "sizeProfile", "plus", "privacy", "help", "settings"]) expect(ids).toContain(id);
  });
  it("hides account-bound rows", () => {
    for (const id of ["wallet", "rewards", "giftCards", "budget", "stylist", "addresses", "autoBuy", "outfitCalendar", "wardrobe"]) expect(ids).not.toContain(id);
  });
});

describe("honest states", () => {
  it("orders and returns have their own copy; deferred and hidden use the generic ones", () => {
    expect(guestStateCopy("orders").bodyKey).toBe("guestStates.ordersBody");
    expect(guestStateCopy("returns").titleKey).toBe("guestStates.returnsTitle");
    expect(guestStateCopy("budget").titleKey).toBe("guestStates.deferredTitle");
    expect(guestStateCopy("wallet").titleKey).toBe("guestStates.unavailableTitle");
  });
  it("names the existing quiet routes", () => {
    expect(SIGN_IN_ROUTE).toBe("/sign-in");
    expect(SELL_ROUTE).toBe("/brand");
  });
});

/** Owner rule R0: only the Checkout gate (G2) asks a guest to create an account. */
describe("source guard", () => {
  const roots = ["me", "settings", "privacy-center", "pdp", "size-profile", "plus", "gift-cards", "drops", "purchase"].map((d) => join(__dirname, "..", d));
  const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) && !/\.test\./.test(n) ? [p] : [];
  });
  it("no guest-facing file references the sign-up or account-creation routes", () => {
    const bad = /["'`]\/sign-up|account-creation|AccountCreate|\/onboarding\/|checkout-gate|CheckoutGate/;
    for (const f of roots.flatMap(files)) expect(readFileSync(f, "utf8"), f).not.toMatch(bad);
  });
});

/** Route audit: server-bound routes must be guarded so a guest never reaches a 401 screen. */
describe("route guard audit", () => {
  const app = join(__dirname, "..", "..", "app");
  const read = (rel: string) => readFileSync(join(app, rel), "utf8");
  it("family-invite and brand-mode check guest mode before any server call", () => {
    expect(read("family-invite/[token].tsx")).toMatch(/<GuestGate feature="family">/);
    expect(read("brand-mode/_layout.tsx")).toMatch(/useGuestGateMode/);
    expect(read("brand-mode/_layout.tsx")).toMatch(/mode === "guest"/);
  });
  it("every guest-guarded route file uses GuestGate", () => {
    for (const r of Object.keys(GUEST_ROUTES)) {
      const rel = r === "/privacy-center" ? "privacy-center.tsx" : `${r.slice(1)}.tsx`;
      expect(read(rel), rel).toMatch(/GuestGate/);
    }
  });
  it("family is a hidden feature with no entry point", () => {
    expect(guestRule("family")).toEqual({ kind: "hidden", entry: false, screen: false });
    expect(guestStateCopy("family").titleKey).toBe("guestStates.unavailableTitle");
  });
});
