import { describe, expect, it } from "vitest";
import {
  GuardRejectedError,
  InvalidTransitionError,
  kycMachine,
} from "@outlet/domain";
import { pageOf, widenHint, worldFilter, type DirectoryItem } from "./domain/directory";
import { advanceLastSeen, newSince, replaceFavorites } from "./domain/favorites";
import {
  healthBadge,
  hiddenReason,
  isShopperVisible,
  nextSellerKycState,
  nextStoreStatus,
  publicDiscountPct,
  publicRating,
  storeStatusMachine,
  StoreRuleError,
} from "./domain/store";
import { EMPTY_STATS, makeStore, uuid } from "./test/fixtures";

const item = (n: number, over: Parameters<typeof makeStore>[1] = {}, pos: number | null = null): DirectoryItem => ({
  store: makeStore(n, over),
  favoritePosition: pos,
});

describe("visibility", () => {
  it("shows ACTIVE and PAUSED stores of an APPROVED seller with published legal identity", () => {
    expect(isShopperVisible(makeStore(1))).toBe(true);
    expect(isShopperVisible(makeStore(1, { status: "PAUSED" }))).toBe(true);
  });

  it.each([
    ["draft", { status: "DRAFT" as const }],
    ["suspended store", { status: "SUSPENDED" as const }],
    ["seller suspended", { sellerKycState: "SUSPENDED" as const }],
    ["seller under review", { sellerKycState: "AUTO_CHECKS" as const }],
    ["seller needs info", { sellerKycState: "NEEDS_INFO" as const }],
    ["seller terminated", { sellerKycState: "TERMINATED" as const }],
    ["no legal identity (B5 fail closed)", { legalIdentity: null }],
  ])("hides %s", (_name, over) => {
    expect(isShopperVisible(makeStore(1, over))).toBe(false);
  });

  it("explains hidden favourites with a coarse reason that does not leak internal state", () => {
    expect(hiddenReason(makeStore(1))).toBeNull();
    expect(hiddenReason(makeStore(1, { status: "SUSPENDED" }))).toBe("suspended");
    expect(hiddenReason(makeStore(1, { sellerKycState: "SUSPENDED" }))).toBe("suspended");
    expect(hiddenReason(makeStore(1, { status: "DRAFT", sellerKycState: "DRAFT" }))).toBe("unavailable");
    expect(hiddenReason(makeStore(1, { sellerKycState: "TERMINATED" }))).toBe("unavailable");
  });
});

describe("never fake data", () => {
  it("only verified-looking discounts 5..100 survive", () => {
    expect(publicDiscountPct(null)).toBeNull();
    expect(publicDiscountPct(4)).toBeNull();
    expect(publicDiscountPct(5)).toBe(5);
    expect(publicDiscountPct(100)).toBe(100);
    expect(publicDiscountPct(101)).toBeNull();
    expect(publicDiscountPct(12.5)).toBeNull();
  });

  it("no rating without ratings", () => {
    expect(publicRating(4.8, 0)).toBeNull();
    expect(publicRating(null, 3)).toBeNull();
    expect(publicRating(5.5, 3)).toBeNull();
    expect(publicRating(4.5, 3)).toBe(4.5);
  });

  it("health badge thresholds", () => {
    expect(healthBadge(null)).toBeUndefined();
    expect([healthBadge(80), healthBadge(79), healthBadge(50), healthBadge(49)]).toEqual(["good", "fair", "fair", "poor"]);
  });
});

describe("store lifecycle", () => {
  it("reaches every state and has no terminal state (the platform can always reinstate)", () => {
    const a = storeStatusMachine.analyze();
    expect(a.unreachable).toEqual([]);
    expect(a.terminalsWithOutgoing).toEqual([]);
  });

  it("follows the documented table", () => {
    const base = { sellerKycState: "APPROVED" as const };
    expect(nextStoreStatus({ ...base, status: "DRAFT" }, "ACTIVATE")).toBe("ACTIVE");
    expect(nextStoreStatus({ ...base, status: "ACTIVE" }, "PAUSE")).toBe("PAUSED");
    expect(nextStoreStatus({ ...base, status: "PAUSED" }, "RESUME")).toBe("ACTIVE");
    expect(nextStoreStatus({ ...base, status: "PAUSED" }, "SUSPEND")).toBe("SUSPENDED");
    expect(nextStoreStatus({ ...base, status: "SUSPENDED" }, "REINSTATE")).toBe("ACTIVE");
    expect(() => nextStoreStatus({ ...base, status: "DRAFT" }, "SUSPEND")).toThrow(InvalidTransitionError);
    expect(() => nextStoreStatus({ ...base, status: "SUSPENDED" }, "PAUSE")).toThrow(InvalidTransitionError);
  });

  it("refuses to activate or reinstate for a seller that is not approved", () => {
    expect(() => nextStoreStatus({ status: "DRAFT", sellerKycState: "AUTO_CHECKS" }, "ACTIVATE")).toThrow(StoreRuleError);
    expect(() => nextStoreStatus({ status: "SUSPENDED", sellerKycState: "SUSPENDED" }, "REINSTATE")).toThrow(StoreRuleError);
  });
});

describe("seller KYC goes through the shared machine", () => {
  const ok = { documentsValid: true, sanctionsClear: true, signatoryAdult21: true };

  it("matches the shared kycMachine for every state and event", () => {
    for (const state of kycMachine.states) {
      for (const event of kycMachine.events) {
        const expected = (() => {
          try {
            return kycMachine.transition(state, event, ok);
          } catch {
            return "throws";
          }
        })();
        const actual = (() => {
          try {
            return nextSellerKycState(state, event, ok);
          } catch {
            return "throws";
          }
        })();
        expect(actual).toBe(expected);
      }
    }
  });

  it("approval is guarded by documents, sanctions and 21+ signatory", () => {
    expect(() => nextSellerKycState("AUTO_CHECKS", "APPROVE", { ...ok, signatoryAdult21: false })).toThrow(GuardRejectedError);
    expect(nextSellerKycState("AUTO_CHECKS", "APPROVE", ok)).toBe("APPROVED");
  });
});

describe("replaceFavorites", () => {
  const visible = (ids: readonly string[]) => (id: string) => ids.includes(id);
  const a = uuid(1);
  const b = uuid(2);
  const c = uuid(3);

  it("assigns dense positions in request order and keeps last_seen_at of retained stores", () => {
    const r = replaceFavorites([{ storeId: b, position: 0, lastSeenAtMs: 50 }], [a, b, c], visible([a, b, c]), 1_000);
    expect(r).toEqual({
      ok: true,
      rows: [
        { storeId: a, position: 0, lastSeenAtMs: 1_000 },
        { storeId: b, position: 1, lastSeenAtMs: 50 },
        { storeId: c, position: 2, lastSeenAtMs: 1_000 },
      ],
    });
  });

  it("rejects over 30, duplicates and unknown or hidden stores with one unknown answer", () => {
    const ids = Array.from({ length: 31 }, (_, i) => uuid(100 + i));
    expect(replaceFavorites([], ids, () => true, 0)).toEqual({ ok: false, error: { kind: "too_many_favorites", max: 30 } });
    expect(replaceFavorites([], [a, a], visible([a]), 0)).toEqual({ ok: false, error: { kind: "duplicate_store" } });
    expect(replaceFavorites([], [a, b], visible([a]), 0)).toEqual({ ok: false, error: { kind: "unknown_store" } });
  });

  it("accepts exactly 30 and the empty list", () => {
    const ids = Array.from({ length: 30 }, (_, i) => uuid(100 + i));
    expect(replaceFavorites([], ids, () => true, 0).ok).toBe(true);
    expect(replaceFavorites([{ storeId: a, position: 0, lastSeenAtMs: 1 }], [], () => true, 0)).toEqual({ ok: true, rows: [] });
  });
});

describe("last seen and new counters", () => {
  it("never moves backwards and is idempotent", () => {
    const row = { storeId: uuid(1), position: 0, lastSeenAtMs: 100 };
    expect(advanceLastSeen(row, 50)).toBe(row);
    const next = advanceLastSeen(row, 200);
    expect(next.lastSeenAtMs).toBe(200);
    expect(advanceLastSeen(next, 200)).toBe(next);
  });

  it("counts strictly after the last visit", () => {
    expect(newSince([100, 101, 150, 99], 100)).toBe(2);
    expect(newSince([], 100)).toBe(0);
  });
});

describe("directory paging and sorting", () => {
  const items = [
    item(1, { stats: { ...EMPTY_STATS, trendingScore: 5, maxVerifiedDiscountPct: 30, p80DeliveryHours: 48 } }),
    item(2, { stats: { ...EMPTY_STATS, trendingScore: 9, maxVerifiedDiscountPct: null, p80DeliveryHours: 24 } }),
    item(3, { stats: { ...EMPTY_STATS, trendingScore: 9, maxVerifiedDiscountPct: 50, p80DeliveryHours: null } }),
    item(4, { kind: "global", nameAr: "أ", stats: { ...EMPTY_STATS, trendingScore: 1, lastDropAtMs: 5_000 } }),
  ];
  const ids = (page: { items: readonly DirectoryItem[] }) => page.items.map((i) => i.store.id);

  it("trending desc with id tie-break", () => {
    expect(ids(pageOf(items, "trending", null, 10))).toEqual([uuid(2), uuid(3), uuid(1), uuid(4)]);
  });

  it("puts null keys last in both directions", () => {
    expect(ids(pageOf(items, "biggest_verified_discount", null, 10))).toEqual([uuid(3), uuid(1), uuid(2), uuid(4)]);
    expect(ids(pageOf(items, "fastest_delivery", null, 10)).slice(0, 2)).toEqual([uuid(2), uuid(1)]);
    expect(ids(pageOf(items, "new_drops", null, 10))[0]).toBe(uuid(4));
  });

  it("sorts by Arabic name ascending", () => {
    expect(ids(pageOf(items, "name", null, 10))[0]).toBe(uuid(4));
  });

  it("pages through with a keyset cursor without repeats", () => {
    const p1 = pageOf(items, "trending", null, 2);
    expect(p1.hasMore).toBe(true);
    const p2 = pageOf(items, "trending", p1.last, 2);
    expect(p2.hasMore).toBe(false);
    expect([...ids(p1), ...ids(p2)]).toEqual([uuid(2), uuid(3), uuid(1), uuid(4)]);
  });

  it("filters worlds", () => {
    expect(items.filter((i) => worldFilter("local", i)).length).toBe(3);
    expect(items.filter((i) => worldFilter("global", i)).length).toBe(1);
    expect(items.filter((i) => worldFilter("everything", i)).length).toBe(4);
    expect(items.filter((i) => worldFilter("my_stores", i)).length).toBe(0);
  });

  it("widens only for an empty My Stores", () => {
    expect(widenHint("my_stores", 0)).toEqual({ kind: "widen_world", suggestedWorld: "everything" });
    expect(widenHint("my_stores", 1)).toBeNull();
    expect(widenHint("local", 0)).toBeNull();
  });
});
