import { describe, expect, it } from "vitest";
import { planDateAlerts, planSignalAlert, type CatalogSignal } from "./domain/alerts";
import { LIMITS, type Money, type Wishlist, type WishlistItem } from "./domain/types";
import {
  activeCoolOff,
  applyUpdate,
  cairoDate,
  coolOffUntil,
  createWishlist,
  daysUntil,
  isShareActive,
  newShareLink,
  revokeShare,
  type NewWishlistInput,
} from "./domain/wishlist";
import { decodeCursor, encodeCursor } from "./application/wishlists";

const NOW = 1_800_000_000_000; // 2027-01-15 08:00Z, Cairo 2027-01-15
const U = "0192f3a4-5b6c-7d8e-9f01-000000000001";
const egp = (n: bigint): Money => ({ amount: n, currency: "EGP" });

/** Deterministic PRNG (mulberry32) so property tests are reproducible without extra dependencies. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const int = (r: () => number, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
const RUNS = 500;

const base: NewWishlistInput = {
  intent: "need",
  title: "  Eid   outfits ",
  targetDate: null,
  budget: null,
  giftFor: null,
  coolOffEnabled: false,
};
const make = (over: Partial<NewWishlistInput> = {}, nowMs = NOW): Wishlist => {
  const r = createWishlist({ ...base, ...over }, { id: "w1", userId: U, nowMs });
  if (!r.ok) throw new Error(`unexpected ${r.error}`);
  return r.value;
};
const item = (over: Partial<WishlistItem> = {}): WishlistItem => ({
  id: "i1",
  wishlistId: "w1",
  userId: U,
  productId: "p1",
  skuPref: null,
  addedPrice: egp(100_000n),
  note: null,
  coolOffUntilMs: null,
  addedAtMs: NOW,
  ...over,
});

describe("createWishlist rules", () => {
  it("trims and collapses the title", () => {
    expect(make().title).toBe("Eid outfits");
  });

  it("rejects empty, over-long and control-character titles", () => {
    for (const title of ["   ", "x".repeat(81), "a\u0000b"]) {
      const r = createWishlist({ ...base, title }, { id: "w", userId: U, nowMs: NOW });
      expect(r).toEqual({ ok: false, error: "title_invalid" });
    }
  });

  it("accepts Arabic titles", () => {
    expect(make({ title: "ملابس العيد" }).title).toBe("ملابس العيد");
  });

  it("validates the target date against the Cairo calendar", () => {
    expect(cairoDate(NOW)).toBe("2027-01-15");
    expect(createWishlist({ ...base, targetDate: "2027-01-15" }, { id: "w", userId: U, nowMs: NOW }).ok).toBe(true);
    expect(createWishlist({ ...base, targetDate: "2027-01-14" }, { id: "w", userId: U, nowMs: NOW })).toEqual({
      ok: false,
      error: "target_date_in_past",
    });
    expect(createWishlist({ ...base, targetDate: "2027-02-30" }, { id: "w", userId: U, nowMs: NOW })).toEqual({
      ok: false,
      error: "target_date_invalid",
    });
  });

  it("uses the Cairo day, not the UTC day, around midnight", () => {
    // 2027-01-14T22:30:00Z is already 2027-01-15 00:30 in Cairo (UTC+2 in winter).
    expect(cairoDate(Date.UTC(2027, 0, 14, 22, 30))).toBe("2027-01-15");
  });

  it("bounds the budget", () => {
    const at = (amount: bigint) => createWishlist({ ...base, budget: egp(amount) }, { id: "w", userId: U, nowMs: NOW });
    expect(at(0n)).toEqual({ ok: false, error: "budget_invalid" });
    expect(at(-5n)).toEqual({ ok: false, error: "budget_invalid" });
    expect(at(LIMITS.budgetMaxMinor).ok).toBe(true);
    expect(at(LIMITS.budgetMaxMinor + 1n)).toEqual({ ok: false, error: "budget_invalid" });
  });

  it("requires gift_for exactly for gift lists", () => {
    const ctx = { id: "w", userId: U, nowMs: NOW };
    expect(createWishlist({ ...base, intent: "gift_for_someone" }, ctx)).toEqual({ ok: false, error: "gift_for_required" });
    expect(createWishlist({ ...base, giftFor: { nickname: "Sara", occasion: null, date: null } }, ctx)).toEqual({
      ok: false,
      error: "gift_for_not_allowed",
    });
    const g = createWishlist(
      { ...base, intent: "gift_for_someone", giftFor: { nickname: " Sara ", occasion: "Wedding", date: "2027-03-01" } },
      ctx,
    );
    expect(g.ok && g.value.giftFor).toEqual({ nickname: "Sara", occasion: "Wedding", date: "2027-03-01" });
  });

  it("allows cool-off only on Want lists", () => {
    const ctx = { id: "w", userId: U, nowMs: NOW };
    expect(createWishlist({ ...base, intent: "treat", coolOffEnabled: true }, ctx)).toEqual({
      ok: false,
      error: "cool_off_requires_want",
    });
    expect(createWishlist({ ...base, intent: "want", coolOffEnabled: true }, ctx).ok).toBe(true);
  });
});

describe("applyUpdate", () => {
  it("changes only the given fields and reports cool-off clearing", () => {
    const want = make({ intent: "want", coolOffEnabled: true });
    const r = applyUpdate(want, { coolOffEnabled: false, title: "New" }, NOW + 1000);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.clearCoolOffTimers).toBe(true);
      expect(r.value.wishlist.title).toBe("New");
      expect(r.value.wishlist.intent).toBe("want");
      expect(r.value.wishlist.updatedAtMs).toBe(NOW + 1000);
    }
  });

  it("refuses to enable cool-off on a non-Want list", () => {
    expect(applyUpdate(make(), { coolOffEnabled: true }, NOW)).toEqual({ ok: false, error: "cool_off_requires_want" });
  });

  it("keeps an unchanged past target date (no spurious failure)", () => {
    const l = { ...make({ targetDate: "2027-01-20" }), targetDate: "2027-01-10" };
    expect(applyUpdate(l, { targetDate: "2027-01-10" }, NOW).ok).toBe(true);
    expect(applyUpdate(l, { targetDate: "2027-01-11" }, NOW)).toEqual({ ok: false, error: "target_date_in_past" });
  });
});

describe("cool-off (property)", () => {
  it("is exactly 24 hours after adding, only for enabled Want lists, and expires on the server clock", () => {
    const r = rng(1);
    for (let n = 0; n < RUNS; n++) {
      const added = int(r, 1_700_000_000_000, 1_900_000_000_000);
      const intent = (["want", "need", "treat", "custom"] as const)[int(r, 0, 3)] ?? "need";
      const enabled = r() < 0.5;
      const until = coolOffUntil({ intent, coolOffEnabled: enabled }, added);
      if (intent === "want" && enabled) {
        expect(until).toBe(added + LIMITS.coolOffMs);
        const probe = added + int(r, 0, 2 * LIMITS.coolOffMs);
        const shown = activeCoolOff({ coolOffUntilMs: until }, probe);
        expect(shown !== null).toBe(probe < added + LIMITS.coolOffMs);
      } else {
        expect(until).toBeNull();
        expect(activeCoolOff({ coolOffUntilMs: until }, added)).toBeNull();
      }
    }
  });
});

describe("share links (property)", () => {
  it("is active exactly while not revoked and not expired", () => {
    const r = rng(2);
    for (let n = 0; n < RUNS; n++) {
      const expiry = r() < 0.4 ? null : NOW + int(r, 1, LIMITS.shareMaxLifetimeMs);
      const l = newShareLink({ tokenHash: "h", expiresAtMs: expiry, hidePrices: r() < 0.5 }, NOW);
      expect(l.ok).toBe(true);
      if (!l.ok) continue;
      const probe = NOW + int(r, 0, LIMITS.shareMaxLifetimeMs + 1000);
      expect(isShareActive(l.value, probe)).toBe(expiry === null || probe < expiry);
      const revoked = revokeShare(l.value, probe);
      expect(isShareActive(revoked, probe)).toBe(false);
      // Revoking twice keeps the first revocation time.
      expect(revokeShare(revoked, probe + 5).revokedAtMs).toBe(probe);
    }
  });

  it("rejects past and over-long expiries", () => {
    expect(newShareLink({ tokenHash: "h", expiresAtMs: NOW, hidePrices: false }, NOW).ok).toBe(false);
    expect(newShareLink({ tokenHash: "h", expiresAtMs: NOW + LIMITS.shareMaxLifetimeMs + 1, hidePrices: false }, NOW).ok).toBe(false);
    expect(newShareLink({ tokenHash: "h", expiresAtMs: NOW + LIMITS.shareMaxLifetimeMs, hidePrices: false }, NOW).ok).toBe(true);
  });
});

describe("alert planning (property)", () => {
  it("fires date alerts only at exactly 7 and 1 Cairo days", () => {
    const r = rng(3);
    for (let n = 0; n < RUNS; n++) {
      const offset = int(r, 0, 60);
      const date = new Date(Date.UTC(2027, 0, 15 + offset)).toISOString().slice(0, 10);
      const list = { ...make(), targetDate: date };
      const planned = planDateAlerts(list, NOW);
      const expected = offset === 7 || offset === 1;
      expect(planned.length).toBe(expected ? 1 : 0);
      expect(daysUntil(date, cairoDate(NOW))).toBe(offset);
      if (expected) expect(planned[0]?.daysBefore).toBe(offset);
    }
  });

  it("dedupe keys are stable for the same inputs and distinct across items", () => {
    const sig: CatalogSignal = { kind: "stock_level", eventId: "e1", productId: "p1", skuId: "s1", available: 2 };
    const a = planSignalAlert(sig, item({ id: "a" }));
    const b = planSignalAlert(sig, item({ id: "b" }));
    expect(a?.dedupeKey).toBe(planSignalAlert(sig, item({ id: "a" }))?.dedupeKey);
    expect(a?.dedupeKey).not.toBe(b?.dedupeKey);
  });

  it("low stock fires iff 1 <= available <= 3 and the size matches", () => {
    const r = rng(4);
    for (let n = 0; n < RUNS; n++) {
      const available = int(r, -1, 10);
      const pref = r() < 0.5 ? "s1" : null;
      const sku = r() < 0.5 ? "s1" : "s2";
      const planned = planSignalAlert(
        { kind: "stock_level", eventId: "e", productId: "p1", skuId: sku, available },
        item({ skuPref: pref }),
      );
      const expected = available >= 1 && available <= 3 && (pref === null || pref === sku);
      expect(planned !== null).toBe(expected);
    }
  });

  it("price-drop fires iff the verified price is below the price when added", () => {
    const r = rng(5);
    for (let n = 0; n < RUNS; n++) {
      const added = BigInt(int(r, 1, 1_000_000));
      const now = BigInt(int(r, 1, 1_000_000));
      const planned = planSignalAlert(
        { kind: "verified_price_drop", eventId: "e", productId: "p1", claimId: "c", newPrice: egp(now) },
        item({ addedPrice: egp(added) }),
      );
      expect(planned !== null).toBe(now < added);
    }
  });

  it("back-in-size needs a preferred size that matches", () => {
    const sig: CatalogSignal = { kind: "back_in_size", eventId: "e", productId: "p1", skuId: "s1" };
    expect(planSignalAlert(sig, item({ skuPref: null }))).toBeNull();
    expect(planSignalAlert(sig, item({ skuPref: "s2" }))).toBeNull();
    expect(planSignalAlert(sig, item({ skuPref: "s1" }))?.alertType).toBe("back_in_size");
  });

  it("ignores a signal for another product", () => {
    expect(
      planSignalAlert({ kind: "back_in_size", eventId: "e", productId: "other", skuId: "s1" }, item({ skuPref: "s1" })),
    ).toBeNull();
  });
});

describe("cursor (property)", () => {
  it("round-trips and rejects junk", () => {
    const r = rng(6);
    for (let n = 0; n < RUNS; n++) {
      const c = { createdAtMs: int(r, 0, 2_000_000_000_000), id: `id-${int(r, 0, 1e9)}` };
      expect(decodeCursor(encodeCursor(c))).toEqual(c);
    }
    for (const junk of ["", "!!", "e30", Buffer.from("[1]").toString("base64url"), Buffer.from('["a","b"]').toString("base64url")]) {
      expect(decodeCursor(junk)).toBeNull();
    }
  });
});
