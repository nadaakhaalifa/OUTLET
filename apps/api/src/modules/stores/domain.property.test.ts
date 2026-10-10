import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { kycMachine, KYC_EVENTS, type KycState } from "@outlet/domain";
import { pageOf, type DirectoryItem, type Ordering } from "./domain/directory";
import { advanceLastSeen, replaceFavorites } from "./domain/favorites";
import { isShopperVisible, nextSellerKycState, publicDiscountPct, SORTS, STORE_STATUSES } from "./domain/store";
import { EMPTY_STATS, makeStore, uuid } from "./test/fixtures";

const statsArb = fc.record({
  maxVerifiedDiscountPct: fc.option(fc.integer({ min: 0, max: 120 }), { nil: null }),
  ratingAvg: fc.constant(null),
  ratingCount: fc.constant(0),
  liveDrop: fc.boolean(),
  trendingScore: fc.integer({ min: 0, max: 5 }),
  lastDropAtMs: fc.option(fc.integer({ min: 0, max: 5 }), { nil: null }),
  p80DeliveryHours: fc.option(fc.integer({ min: 1, max: 5 }), { nil: null }),
});

const itemsArb = fc
  .array(fc.record({ stats: statsArb, name: fc.string({ minLength: 1, maxLength: 3 }), pos: fc.option(fc.integer({ min: 0, max: 40 }), { nil: null }) }), {
    minLength: 0,
    maxLength: 25,
  })
  .map((rows): DirectoryItem[] =>
    rows.map((r, i) => ({ store: makeStore(i + 1, { nameAr: r.name, stats: r.stats }), favoritePosition: r.pos })),
  );

const orderingArb = fc.constantFrom<Ordering>(...SORTS, "favorite_position");

describe("property: keyset pagination", () => {
  it("covers every item exactly once, in a total order, for any page size", () => {
    fc.assert(
      fc.property(itemsArb, orderingArb, fc.integer({ min: 1, max: 7 }), (items, ordering, limit) => {
        const seen: string[] = [];
        let after = null;
        for (let guard = 0; guard < 100; guard += 1) {
          const page = pageOf(items, ordering, after, limit);
          seen.push(...page.items.map((i) => i.store.id));
          if (!page.hasMore) break;
          expect(page.last).not.toBeNull();
          after = page.last;
        }
        expect(seen.length).toBe(items.length);
        expect(new Set(seen).size).toBe(items.length);
        expect(pageOf(items, ordering, null, 1000).items.map((i) => i.store.id)).toEqual(seen);
      }),
      { numRuns: 200 },
    );
  });
});

describe("property: favourites", () => {
  it("any accepted replace has dense unique positions and at most 30 rows", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 40 }), { maxLength: 45 }), (ns) => {
        const ids = ns.map(uuid);
        const r = replaceFavorites([], ids, () => true, 7);
        if (r.ok) {
          expect(r.rows.length).toBeLessThanOrEqual(30);
          expect(r.rows.map((x) => x.position)).toEqual(r.rows.map((_, i) => i));
          expect(new Set(r.rows.map((x) => x.storeId)).size).toBe(r.rows.length);
        } else {
          expect(ids.length > 30 || new Set(ids).size !== ids.length).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("last_seen_at is monotone under any sequence of visits", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 1_000 }), { minLength: 1, maxLength: 20 }), (times) => {
        let row = { storeId: uuid(1), position: 0, lastSeenAtMs: 0 };
        let prev = row.lastSeenAtMs;
        for (const t of times) {
          row = advanceLastSeen(row, t);
          expect(row.lastSeenAtMs).toBeGreaterThanOrEqual(prev);
          prev = row.lastSeenAtMs;
        }
        expect(row.lastSeenAtMs).toBe(Math.max(0, ...times));
      }),
    );
  });
});

describe("property: seller KYC cascade and visibility", () => {
  const ctxArb = fc.record({ documentsValid: fc.boolean(), sanctionsClear: fc.boolean(), signatoryAdult21: fc.boolean() });

  it("a store is visible iff its seller is APPROVED (and it trades), over any event sequence", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.constantFrom(...KYC_EVENTS), ctxArb), { maxLength: 30 }), fc.constantFrom(...STORE_STATUSES), (steps, status) => {
        let state: KycState = kycMachine.initial;
        for (const [event, ctx] of steps) {
          try {
            state = nextSellerKycState(state, event, ctx);
          } catch {
            // typed rejection leaves the state unchanged
          }
          const store = makeStore(1, { status, sellerKycState: state });
          const trading = status === "ACTIVE" || status === "PAUSED";
          expect(isShopperVisible(store)).toBe(state === "APPROVED" && trading);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("a suspended or terminated seller is never visible, whatever the store status", () => {
    for (const status of STORE_STATUSES) {
      for (const kyc of ["SUSPENDED", "TERMINATED", "REJECTED"] as const) {
        expect(isShopperVisible(makeStore(1, { status, sellerKycState: kyc }))).toBe(false);
      }
    }
  });
});

describe("property: no fake discounts", () => {
  it("publicDiscountPct is null or an integer in 5..100 and is the identity there", () => {
    fc.assert(
      fc.property(fc.option(fc.double({ min: -50, max: 200, noNaN: true }), { nil: null }), (v) => {
        const out = publicDiscountPct(v);
        if (out !== null) {
          expect(Number.isInteger(out)).toBe(true);
          expect(out).toBeGreaterThanOrEqual(5);
          expect(out).toBeLessThanOrEqual(100);
          expect(out).toBe(v);
        }
        void EMPTY_STATS;
      }),
    );
  });
});
