import { describe, expect, it } from "vitest";
import { COOL_OFF_MS, InMemoryWishlistsPort, buildList, buyAction, validateDraft, type Wishlist, type WishlistItem } from "./model";

const item = (o: Partial<WishlistItem> = {}): WishlistItem => ({
  id: "i", productId: "p", title: "t", addedPrice: 1000n, currentPrice: 1000n, status: "listed", note: null, coolOffStartedAtMs: null, ...o,
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
