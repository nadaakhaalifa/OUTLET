import { describe, expect, it, vi } from "vitest";
import { DeviceRoleChoicePort } from "./api";
import { InMemoryRoleChoicePort, parseRole, resolveEntry, type EntryFacts } from "./model";

const base: EntryFacts = { blocked: false, role: null, regionChosen: true };

describe("resolveEntry (ADR-0055 truth table)", () => {
  it("first launch: region screen first", () => expect(resolveEntry({ ...base, regionChosen: false })).toBe("/welcome-region"));
  it("region chosen, entrance page not seen: entrance page once", () => expect(resolveEntry(base)).toBe("/role"));
  it("returning guest (region + entrance done): straight to Home", () => expect(resolveEntry({ ...base, role: "shopper" })).toBe("/(tabs)"));
  it("returning signed-in member: Home as well (a session never changes the route)", () => expect(resolveEntry({ ...base, role: "shopper" })).toBe("/(tabs)"));
  it("region unset on a returning install shows only the region screen, then continues", () => {
    expect(resolveEntry({ ...base, role: "shopper", regionChosen: false })).toBe("/welcome-region");
    expect(resolveEntry({ ...base, role: "shopper", regionChosen: true })).toBe("/(tabs)");
  });
  it("interrupted onboarding never routes to a sign-up screen", () => {
    // Facts about sessions, resume markers and onboarding are not inputs any more; a half-finished sign-up opens Home.
    const routes = [true, false].flatMap((regionChosen) => [null, "shopper" as const, "brand" as const].map((role) => resolveEntry({ blocked: false, role, regionChosen })));
    for (const r of routes) expect(r).not.toMatch(/onboarding\/(account|otp|consents|language)|sign-up/);
  });
  it("age block always wins", () => {
    expect(resolveEntry({ ...base, blocked: true, role: "brand" })).toBe("/onboarding/blocked");
    expect(resolveEntry({ ...base, blocked: true, regionChosen: false })).toBe("/onboarding/blocked");
  });
  it("brand goes to /brand, before the region screen", () => {
    expect(resolveEntry({ ...base, role: "brand" })).toBe("/brand");
    expect(resolveEntry({ ...base, role: "brand", regionChosen: false })).toBe("/brand");
  });
});

describe("role port", () => {
  it("parses only known roles", () => {
    expect(parseRole("shopper")).toBe("shopper");
    expect(parseRole("x")).toBeNull();
  });
  it("fake records the choice", async () => {
    const p = new InMemoryRoleChoicePort();
    await p.choose("brand");
    expect(await p.load()).toBe("brand");
    expect(p.recorded).toEqual(["brand"]);
  });
  it("persists and calls the funnel; funnel failure does not block", async () => {
    let v: string | null = null;
    const funnel = vi.fn().mockRejectedValue(new Error("x"));
    const p = new DeviceRoleChoicePort({ get: async () => v, set: async (s) => { v = s; } }, funnel, async () => true);
    await p.choose("shopper");
    expect(v).toBe("shopper");
    expect(funnel).toHaveBeenCalledWith("shopper");
    expect(await p.load()).toBe("shopper");
  });
});

import { EMPTY_DOB_FIELDS, INITIAL_ATTESTED } from "../dob";
describe("fresh install DOB state", () => {
  it("is empty and unticked", () => {
    expect(EMPTY_DOB_FIELDS).toEqual({ day: "", month: "", year: "" });
    expect(INITIAL_ATTESTED).toBe(false);
  });
});

describe("guest role choice makes no server call", () => {
  it("queues while signed out and sends once after sign-in", async () => {
    let v: string | null = null;
    let session = false;
    const funnel = vi.fn().mockResolvedValue(undefined);
    const p = new DeviceRoleChoicePort({ get: async () => v, set: async (s) => { v = s; } }, funnel, async () => session);
    await p.choose("shopper");
    expect(funnel).not.toHaveBeenCalled();
    session = true;
    await p.flushFunnel();
    await p.flushFunnel();
    expect(funnel).toHaveBeenCalledTimes(1);
  });
  it("default port never sends", async () => {
    const funnel = vi.fn();
    const p = new DeviceRoleChoicePort({ get: async () => null, set: async () => undefined }, funnel);
    await p.choose("shopper");
    expect(funnel).not.toHaveBeenCalled();
  });
});

import { colors } from "@outlet/ui-tokens";
function lum(c: string): number {
  const h = c.replace("#", "");
  const ch = [0, 2, 4].map((i) => { const v = parseInt(h.slice(i, i + 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * (ch[0] ?? 0) + 0.7152 * (ch[1] ?? 0) + 0.0722 * (ch[2] ?? 0);
}
function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

describe("entrance text contrast", () => {
  for (const scheme of ["light", "dark"] as const) {
    it(`${scheme}: text and secondary text on the background are >= 4.5`, () => {
      expect(contrastRatio(colors[scheme].textPrimary, colors[scheme].background)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(colors[scheme].textSecondary, colors[scheme].background)).toBeGreaterThanOrEqual(4.5);
    });
  }
});

type Rgba = readonly [number, number, number, number];
function parse(c: string): Rgba {
  const m = /^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/.exec(c.replace(/\s/g, ""));
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  const h = c.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
}
function over(top: string, under: string): string {
  const [r, g, b, a] = parse(top);
  const u = parse(under);
  const mix = (x: number, y: number) => Math.round(x * a + y * (1 - a)).toString(16).padStart(2, "0");
  return `#${mix(r, u[0])}${mix(g, u[1])}${mix(b, u[2])}`;
}

describe("entrance glass contrast (worst case backdrop)", () => {
  for (const scheme of ["light", "dark"] as const) {
    it(`${scheme}: text over the glass tint over the page colour at its darkest and lightest texture is >= 4.5`, () => {
      const c = colors[scheme];
      // The backdrop is the page colour under a faint weave/grain (<= 15% shift toward black or white) and a teal vignette.
      for (const backdrop of [c.background, over("rgba(0,0,0,0.15)", c.background), over("rgba(255,255,255,0.15)", c.background)]) {
        const glassFill = over(c.glassTint, backdrop);
        expect(contrastRatio(c.textPrimary, glassFill)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(c.textSecondary, glassFill)).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});

import { readFileSync } from "node:fs";

describe("entrance navigation (guest rule)", () => {
  const src = readFileSync(new URL("./RoleChoiceScreen.tsx", import.meta.url), "utf8");
  it("shopper goes to Home as a guest, never to account creation", () => {
    expect(src).toContain('router.replace(role === "brand" ? BRAND_ROUTE : "/(tabs)")');
    expect(src).not.toMatch(/onboarding\/account|sign-up|AccountCreate/);
  });
  it("sign in opens the quiet sign-in screen without choosing a role", () => {
    expect(src).toContain('router.push("/sign-in")');
    expect(src).not.toMatch(/const signIn = .*role\.choose/);
  });
});
