import { describe, expect, it } from "vitest";
import {
  FIXTURE_HOME, FIXTURE_HOME_PRODUCTS, InMemoryHomePort, buildHome, claimOf, completeTheLook, endingSoon, forYou, dropBanner, heroCountdown, homeFailure,
  inferKind, scopeProducts, biggestVerifiedDiscounts, newDrops,
} from "./model";
import { FIXTURE_STORES } from "../worlds/model";

const P = FIXTURE_HOME_PRODUCTS;
const NOW = FIXTURE_HOME.serverNowMs;

describe("home rails", () => {
  it("shows only verified, arithmetically consistent claims in the discount rail", () => {
    const ids = biggestVerifiedDiscounts(P).map((p) => p.id);
    expect(ids[0]).toBe("p4");
    expect(ids).not.toContain("p2");
    const bad = { ...P[0]!, verifiedPct: 50 };
    expect(claimOf(bad)).toBeNull();
    expect(biggestVerifiedDiscounts([bad])).toEqual([]);
  });
  it("hides For you entirely when personalization is off or nothing ranks in scope", () => {
    expect(forYou(P, null)).toBeNull();
    expect(forYou(P, ["nope"])).toBeNull();
    expect(forYou(P, ["p6", "p1"])?.map((p) => p.id)).toEqual(["p6", "p1"]);
    expect(buildHome({ ...FIXTURE_HOME, forYouIds: null }, FIXTURE_STORES, "everything", NOW).forYou).toBeNull();
  });
  it("ending soon uses server time and excludes ended or far offers", () => {
    expect(endingSoon(P, NOW).map((p) => p.id)).toEqual(["p4", "p1", "p10", "p3"]);
    expect(endingSoon(P, NOW + 20 * 3_600_000).map((p) => p.id)).toEqual(["p1", "p10", "p3"]);
    expect(endingSoon(P, NOW + 1_000_000 * 3_600_000)).toEqual([]);
  });
  it("new drops are newest first", () => {
    expect(newDrops(P)[0]?.id).toBe("p10");
  });
  it("scopes by world and drops suspended or non-favourite stores", () => {
    expect(scopeProducts(P, FIXTURE_STORES, "global").every((p) => p.storeId === "s3")).toBe(true);
    expect(scopeProducts(P, FIXTURE_STORES, "myStores").some((p) => p.storeId === "s2")).toBe(false);
    expect(buildHome(FIXTURE_HOME, [], "myStores", NOW).empty).toBe(true);
  });
});

describe("hero countdown", () => {
  it("exists only for a real future start", () => {
    const hero = { id: "d", title: "t", storeName: "", variant: "drop" as const, startsAtMs: NOW + 90_061_000, live: false };
    expect(heroCountdown(hero, NOW)).toEqual({ days: 1, hours: 1, minutes: 1, seconds: 1 });
    expect(heroCountdown({ ...hero, startsAtMs: null }, NOW)).toBeNull();
    expect(heroCountdown({ ...hero, startsAtMs: NOW - 1 }, NOW)).toBeNull();
    expect(heroCountdown(null, NOW)).toBeNull();
  });
});

describe("helpers and fakes", () => {
  it("infers placeholder kinds and completes the look without repeating the item", () => {
    expect(inferKind("White linen dress")).toBe("dress");
    expect(inferKind("منتج")).toBe("tee");
    const look = completeTheLook("p1", "dress", P);
    expect(look.every((p) => p.id !== "p1")).toBe(true);
    expect(new Set(look.map((p) => p.kind)).size).toBe(look.length);
  });
  it("reports offline versus failed", async () => {
    const port = new InMemoryHomePort();
    port.setFailure("offline");
    expect(homeFailure(await port.load().catch((e: unknown) => e))).toEqual({ status: "error", offline: true });
  });
});

describe("drop banner", () => {
  const hero = { id: "d", title: "t", storeName: "S", variant: "drop" as const, startsAtMs: NOW + 90_061_000, live: false };
  it("shows an upcoming drop with a server-time countdown", () => {
    expect(dropBanner(hero, NOW)?.countdown).toEqual({ days: 1, hours: 1, minutes: 1, seconds: 1 });
  });
  it("shows live without a countdown and hides when nothing is real", () => {
    expect(dropBanner({ ...hero, live: true, startsAtMs: null }, NOW)).toMatchObject({ live: true, countdown: null });
    expect(dropBanner({ ...hero, startsAtMs: null }, NOW)).toBeNull();
    expect(dropBanner({ ...hero, startsAtMs: NOW - 5 }, NOW)).toBeNull();
    expect(dropBanner(null, NOW)).toBeNull();
  });
});

import { FIXTURE_CATEGORIES } from "../shop-all/model";
import { departmentTap, homeReasonKey, shouldTrackSection, type HomeReasonSection } from "./model";
import { QUICK_ACTION_REASON_KEYS } from "./model";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("round-2 home: department tap", () => {
  it("opens the in-place window for a department with subcategories", () => {
    const tree = [...FIXTURE_CATEGORIES, { id: "dept-kids", slug: "kids-dept", nameEn: "Kids", nameAr: "أطفال", parentId: null }];
    const kids = FIXTURE_CATEGORIES.find((c) => c.slug === "kids")!;
    const withKids = [...FIXTURE_CATEGORIES, { id: "k1", slug: "k-shoes", nameEn: "Shoes", nameAr: "أحذية", parentId: kids.id }];
    const tap = departmentTap(withKids, "kids");
    expect(tap.kind).toBe("window");
    expect(tap.kind === "window" && tap.node.id).toBe(kids.id);
    expect(tree.length).toBeGreaterThan(0);
  });
  it("goes straight to Shop all for filters-only departments and childless nodes", () => {
    expect(departmentTap(FIXTURE_CATEGORIES, "women").kind).toBe("route");
    expect(departmentTap(FIXTURE_CATEGORIES, "kids").kind).toBe("route");
  });
});

describe("round-2 home: reasons and analytics", () => {
  it("picks the located line only with an area, generic otherwise", () => {
    expect(homeReasonKey("stores", "Maadi")).toEqual({ key: "homeReason.storesNear", vars: { area: "Maadi" } });
    expect(homeReasonKey("stores", null).key).toBe("homeReason.storesGeneric");
    expect(homeReasonKey("stores", "").key).toBe("homeReason.storesGeneric");
    expect(homeReasonKey("all_pieces", null).key).toBe("homeReason.allPiecesGeneric");
  });
  it("reason copy never makes a popularity claim (AR and EN)", () => {
    const banned = /trending|popular|viral|best.?sell|most|الأكثر|رائج|شائع|ترند|الأفضل مبيع/i;
    for (const file of ["en.ts", "ar.ts"]) {
      const src = readFileSync(join(__dirname, "../../../../../packages/i18n/src", file), "utf8");
      const start = src.indexOf("homeReason: {");
      const block = src.slice(start, src.indexOf("}", start));
      expect(start).toBeGreaterThan(-1);
      expect(banned.test(block)).toBe(false);
    }
    expect(QUICK_ACTION_REASON_KEYS.every((k) => k.startsWith("homeReason."))).toBe(true);
  });
  it("tracks each section impression once per session", () => {
    const seen = new Set<HomeReasonSection>();
    expect(shouldTrackSection(seen, "stores")).toBe(true);
    expect(shouldTrackSection(seen, "stores")).toBe(false);
    expect(shouldTrackSection(seen, "all_pieces")).toBe(true);
  });
});
