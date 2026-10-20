import { describe, expect, it, vi } from "vitest";
import {
  COOL_OFF_MS, EMPTY_SAVED_FILTER, InMemoryWishlistsPort, SAVED_SORTS, UNDO_MS, UndoTracker, buildList, buyAction, canShare, filterItems, savedFilterCount, savedRow, sortItems, storeNamesOf, validateDraft,
  type Wishlist, type WishlistItem,
} from "./model";

const item = (o: Partial<WishlistItem> = {}): WishlistItem => ({
  id: "i", productId: "p", title: "t", addedPrice: 1000n, currentPrice: 1000n, status: "listed", note: null, storeName: "Store A", storeVerified: false, skuPref: "sku", coolOffStartedAtMs: null, ...o,
});
const list = (o: Partial<Wishlist> = {}): Wishlist => ({
  id: "w", intent: "want", title: "L", targetDate: null, budget: null, recipientNickname: null, occasion: null, coolOffEnabled: true, share: null, items: [], ...o,
});

describe("cool-off", () => {
  it("turns Buy into remind-me on opted-in Want lists", () => {
    expect(buyAction(list(), item(), 0)).toEqual({ kind: "remindTomorrow" });
  });
  it("applies only to Want lists", () => {
    expect(buyAction(list({ intent: "need" }), item(), 0)).toEqual({ kind: "buy" });
    expect(buyAction(list({ coolOffEnabled: false }), item(), 0)).toEqual({ kind: "buy" });
  });
  it("waits a real 24h then allows buying", () => {
    const started = item({ coolOffStartedAtMs: 1_000 });
    expect(buyAction(list(), started, 1_000 + COOL_OFF_MS - 1)).toMatchObject({ kind: "waiting", remainingMs: 1 });
    expect(buyAction(list(), started, 1_000 + COOL_OFF_MS)).toEqual({ kind: "buy" });
  });
  it("delisted items are unavailable", () => {
    expect(buyAction(list(), item({ status: "delisted" }), 0)).toEqual({ kind: "unavailable" });
  });
});

describe("draft validation", () => {
  const base = { intent: "need" as const, title: "x", targetDate: null, budget: null, recipientNickname: null, occasion: null };
  it("requires title, and nickname plus occasion for gifts", () => {
    expect(validateDraft({ ...base, title: " " })).toEqual(["titleRequired"]);
    expect(validateDraft({ ...base, intent: "gift" })).toEqual(["nicknameRequired", "occasionRequired"]);
    expect(validateDraft({ ...base, intent: "gift", recipientNickname: "Mona", occasion: "Eid" })).toEqual([]);
  });
  it("rejects bad budget and date", () => {
    expect(validateDraft({ ...base, budget: 0n, targetDate: "2026-13-45" })).toEqual(["budgetInvalid", "dateInvalid"]);
  });
});

describe("list view", () => {
  it("totals listed items only and reports budget honestly", () => {
    const v = buildList(list({ budget: 1500n, items: [item({ id: "a" }), item({ id: "b", currentPrice: 900n }), item({ id: "c", status: "delisted", currentPrice: null })] }), 0);
    expect(v.total).toBe(1900n);
    expect(v.budgetLeft).toBe(-400n);
    expect(v.items[1]?.priceMoved).toBe("lower");
    expect(v.items[2]?.priceMoved).toBe("unknown");
  });
  it("share is inactive once expired or revoked", () => {
    expect(buildList(list({ share: { url: "u", expiresAtMs: 5 } }), 10).shareActive).toBe(false);
    expect(buildList(list({ share: { url: "u", expiresAtMs: null } }), 10).shareActive).toBe(true);
    expect(buildList(list(), 10).shareActive).toBe(false);
  });
});

describe("port share and cool-off", () => {
  it("creates then revokes a share link and starts cool-off once", async () => {
    const p = new InMemoryWishlistsPort([list({ items: [item()] })]);
    await p.createShare("w", null);
    expect((await p.list())[0]?.share).not.toBeNull();
    await p.revokeShare("w");
    expect((await p.list())[0]?.share).toBeNull();
    await p.startCoolOff("w", "i", 50);
    await p.startCoolOff("w", "i", 99);
    expect((await p.list())[0]?.items[0]?.coolOffStartedAtMs).toBe(50);
  });
});

import { coolOffHoursLeft } from "./model";
import { expect as e4, it as i4 } from "vitest";

i4("rounds cool-off hours up and never shows zero", () => {
  e4(coolOffHoursLeft(1)).toBe(1);
  e4(coolOffHoursLeft(3_600_001)).toBe(2);
  e4(coolOffHoursLeft(23 * 3_600_000)).toBe(23);
});

describe("saved row view", () => {
  const l = list();
  it("shows the price line only when prices differ, never as a percentage", () => {
    expect(savedRow(l, item(), 0, false).priceLine).toBeNull();
    expect(savedRow(l, item({ currentPrice: null }), 0, false).priceLine).toBeNull();
    expect(savedRow(l, item({ currentPrice: 900n }), 0, false).priceLine).toEqual({ was: 1000n, now: 900n, lower: true });
    expect(savedRow(l, item({ currentPrice: 1100n }), 0, false).priceLine).toEqual({ was: 1000n, now: 1100n, lower: false });
  });
  it("delisted: dimmed, badged, price hidden, only Find similar", () => {
    const r = savedRow(l, item({ status: "delisted", currentPrice: null }), 0, true);
    expect(r).toMatchObject({ badge: "unavailable", dimmed: true, price: null, priceLine: null, action: { kind: "findSimilar" } });
  });
  it("in bag: badge and View bag", () => {
    expect(savedRow(list({ intent: "need" }), item(), 0, true)).toMatchObject({ badge: "inBag", action: { kind: "viewBag" } });
  });
  it("cool-off: remind button, then real hours left, then add to bag", () => {
    expect(savedRow(l, item(), 0, false).action).toEqual({ kind: "remindTomorrow" });
    expect(savedRow(l, item({ coolOffStartedAtMs: 0 }), COOL_OFF_MS - 3_600_000, false).action).toEqual({ kind: "waiting", hours: 1 });
    expect(savedRow(l, item({ coolOffStartedAtMs: 0 }), COOL_OFF_MS, false).action).toEqual({ kind: "addToBag" });
  });
});

describe("sort and filter", () => {
  const items = [
    item({ id: "a", currentPrice: 500n, addedPrice: 500n }),
    item({ id: "b", currentPrice: 300n, addedPrice: 900n, storeName: "Store B" }),
    item({ id: "c", status: "delisted", currentPrice: null }),
    item({ id: "d", currentPrice: 800n, addedPrice: 700n }),
  ];
  const ids = (xs: readonly WishlistItem[]) => xs.map((i) => i.id);
  it("sorts by price and by change, with unavailable last", () => {
    expect(ids(sortItems(items, "newest"))).toEqual(["a", "b", "d", "c"]);
    expect(ids(sortItems(items, "priceLow"))).toEqual(["b", "a", "d", "c"]);
    expect(ids(sortItems(items, "priceHigh"))).toEqual(["d", "a", "b", "c"]);
    expect(ids(sortItems(items, "priceChanged"))).toEqual(["b", "d", "a", "c"]);
  });
  it("filters by store, availability and list budget", () => {
    expect(ids(filterItems(items, { ...EMPTY_SAVED_FILTER, stores: ["Store B"] }, null))).toEqual(["b"]);
    expect(ids(filterItems(items, { ...EMPTY_SAVED_FILTER, availableOnly: true }, null))).toEqual(["a", "b", "d"]);
    expect(ids(filterItems(items, { ...EMPTY_SAVED_FILTER, inBudget: true }, 500n))).toEqual(["a", "b"]);
    expect(storeNamesOf(items)).toEqual(["Store A", "Store B"]);
    expect(savedFilterCount({ stores: ["x"], availableOnly: true, inBudget: false })).toBe(2);
  });
  it("sorting is a permutation and idempotent (seeded property loop; fast-check is not a mobile dependency)", () => {
    let seed = 12345;
    const rnd = (n: number): number => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed % n; };
    for (let run = 0; run < 200; run++) {
      const xs = Array.from({ length: rnd(30) }, (_, k) => {
        const gone = rnd(4) === 0;
        return item({ id: `i${k}`, addedPrice: BigInt(1 + rnd(1000)), currentPrice: gone ? null : BigInt(1 + rnd(1000)), status: gone ? "delisted" : "listed" });
      });
      const sort = SAVED_SORTS[rnd(SAVED_SORTS.length)] ?? "newest";
      const out = sortItems(xs, sort);
      expect([...out.map((i) => i.id)].sort()).toEqual([...xs.map((i) => i.id)].sort());
      expect(sortItems(out, sort).map((i) => i.id)).toEqual(out.map((i) => i.id));
    }
  });
  it("only gift and birthday lists are shareable", () => {
    expect(canShare({ intent: "gift" })).toBe(true);
    expect(canShare({ intent: "birthday" })).toBe(true);
    expect(canShare({ intent: "want" })).toBe(false);
  });
});

describe("undo tracker", () => {
  it("undo within the window sends no delete; after it, exactly one", () => {
    vi.useFakeTimers();
    try {
      const commit = vi.fn();
      const t = new UndoTracker(UNDO_MS);
      t.schedule("i1", commit);
      t.schedule("i1", commit);
      vi.advanceTimersByTime(UNDO_MS - 1);
      expect(t.undo("i1")).toBe(true);
      vi.advanceTimersByTime(10_000);
      expect(commit).not.toHaveBeenCalled();
      t.schedule("i2", commit);
      vi.advanceTimersByTime(UNDO_MS);
      expect(commit).toHaveBeenCalledTimes(1);
      expect(t.undo("i2")).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it("flush sends pending removals once", () => {
    vi.useFakeTimers();
    try {
      const commit = vi.fn();
      const t = new UndoTracker();
      t.schedule("i1", commit);
      t.flush();
      vi.advanceTimersByTime(UNDO_MS * 2);
      expect(commit).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});

describe("port remove and bag", () => {
  it("removes an item and records the bag add", async () => {
    const p = new InMemoryWishlistsPort([list({ items: [item()] })]);
    await p.removeItem("w", "i");
    expect((await p.list())[0]?.items).toHaveLength(0);
    await p.addToBag("sku");
    expect(p.bagged).toEqual(["sku"]);
  });
});
