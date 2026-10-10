import { beforeEach, describe, expect, it } from "vitest";
import { money } from "../domain/bridge";
import type { CartLineRecord, CartRecord, CartRepository } from "../domain/ports";

export interface CartRepoContext {
  readonly repo: CartRepository;
  /** Makes the user exist where the store enforces the FK (Postgres); no-op in memory. */
  ensureUser(userId: string): Promise<void>;
}

export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SKU = (n: number): string => `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;
const STORE = "00000000-0000-4000-a000-000000000001";
const T0 = 1_800_000_000_000;

const line = (n: number, over: Partial<CartLineRecord> = {}): CartLineRecord => ({
  id: U(300 + n),
  skuId: SKU(n),
  storeId: STORE,
  qty: 1,
  priceAtAdd: money(50_000n),
  thresholdAtAdd: null,
  state: "IN_BAG",
  source: null,
  unavailableSinceMs: null,
  addedAtMs: T0 + n * 100,
  ...over,
});

/** `updatedAtMs` is owned by the store after `save` (DB trigger), so it is excluded from equality. */
const shape = (c: CartRecord): unknown => ({ ...c, updatedAtMs: 0 });

/** Behaviour every CartRepository must have. Run against in-memory and Kysely/PGlite. */
export function describeCartRepositoryContract(name: string, make: () => Promise<CartRepoContext>): void {
  describe(`CartRepository contract: ${name}`, () => {
    let c: CartRepoContext;
    beforeEach(async () => {
      c = await make();
      await c.ensureUser(U(1));
      await c.ensureUser(U(2));
    });

    it("creates an empty version-0 cart once per user and returns the same one afterwards", async () => {
      const a = await c.repo.getOrCreate(U(1), U(101), T0);
      expect(a).toEqual({ id: U(101), userId: U(1), version: 0, updatedAtMs: T0, lines: [] });
      const b = await c.repo.getOrCreate(U(1), U(999), T0 + 5);
      expect(b.id).toBe(U(101));
      const other = await c.repo.getOrCreate(U(2), U(102), T0);
      expect(other.id).toBe(U(102));
    });

    it("save is compare-and-set: bumps the version, rejects a stale writer and writes no lines for it", async () => {
      const cart = await c.repo.getOrCreate(U(1), U(101), T0);
      const withLine = { ...cart, lines: [line(1)] };
      expect(await c.repo.save(withLine, 0, T0 + 1)).toBe(true);
      const stale = { ...cart, lines: [line(2)] };
      expect(await c.repo.save(stale, 0, T0 + 2)).toBe(false);
      const now = await c.repo.getOrCreate(U(1), U(101), T0 + 3);
      expect(now.version).toBe(1);
      expect(now.lines.map((l) => l.id)).toEqual([U(301)]);
    });

    it("round-trips lines exactly: bigint prices above 2^53, thresholds, state, source, availability", async () => {
      const big = 9_007_199_254_740_993n;
      const cart = await c.repo.getOrCreate(U(1), U(101), T0);
      const lines = [
        line(1, { qty: 10, priceAtAdd: money(big), thresholdAtAdd: money(200_000n), source: "pdp", state: "SAVED_FOR_LATER" }),
        line(2, { unavailableSinceMs: T0 + 12_345, source: "bag_suggestion" }),
        line(3, { priceAtAdd: money(0n) }),
      ];
      expect(await c.repo.save({ ...cart, lines }, 0, T0 + 1)).toBe(true);
      const back = await c.repo.getOrCreate(U(1), U(101), T0 + 2);
      expect(back.lines).toEqual(lines);
      expect(back.lines[0]?.priceAtAdd.amount).toBe(big);
      expect(back.version).toBe(1);
    });

    it("keeps shopper order and supports removal, replacement and quantity change in one save", async () => {
      const cart = await c.repo.getOrCreate(U(1), U(101), T0);
      await c.repo.save({ ...cart, lines: [line(1), line(2), line(3)] }, 0, T0 + 1);
      const v1 = await c.repo.getOrCreate(U(1), U(101), T0 + 2);
      const next = { ...v1, lines: [{ ...line(1), qty: 4 }, line(3)] };
      expect(await c.repo.save(next, 1, T0 + 3)).toBe(true);
      const v2 = await c.repo.getOrCreate(U(1), U(101), T0 + 4);
      expect(v2.lines).toEqual(next.lines);
      expect(shape(v2)).toEqual(shape({ ...next, version: 2 }));
      // same SKU re-added under a new line id replaces the old line
      const re = { ...v2, lines: [{ ...line(1), id: U(399) }, line(3)] };
      expect(await c.repo.save(re, 2, T0 + 5)).toBe(true);
      expect((await c.repo.getOrCreate(U(1), U(101), T0 + 6)).lines.map((l) => l.id)).toEqual([U(399), U(303)]);
    });

    it("setUnavailableSince sets and clears marks without bumping the version, for the owner only", async () => {
      const cart = await c.repo.getOrCreate(U(1), U(101), T0);
      await c.repo.save({ ...cart, lines: [line(1), line(2)] }, 0, T0 + 1);
      await c.repo.setUnavailableSince(U(1), [{ lineId: U(301), sinceMs: T0 + 77 }]);
      let now = await c.repo.getOrCreate(U(1), U(101), T0 + 2);
      expect(now.version).toBe(1);
      expect(now.lines.map((l) => l.unavailableSinceMs)).toEqual([T0 + 77, null]);
      // another user cannot touch it
      await c.repo.setUnavailableSince(U(2), [{ lineId: U(301), sinceMs: T0 + 1 }]);
      now = await c.repo.getOrCreate(U(1), U(101), T0 + 3);
      expect(now.lines[0]?.unavailableSinceMs).toBe(T0 + 77);
      await c.repo.setUnavailableSince(U(1), [{ lineId: U(301), sinceMs: null }]);
      expect((await c.repo.getOrCreate(U(1), U(101), T0 + 4)).lines[0]?.unavailableSinceMs).toBeNull();
    });

    it("findLineOwner returns the true owner, null for unknown or malformed ids", async () => {
      const cart = await c.repo.getOrCreate(U(1), U(101), T0);
      await c.repo.save({ ...cart, lines: [line(1)] }, 0, T0 + 1);
      expect(await c.repo.findLineOwner(U(301))).toBe(U(1));
      expect(await c.repo.findLineOwner(U(398))).toBeNull();
      expect(await c.repo.findLineOwner("not-a-uuid")).toBeNull();
    });
  });
}
