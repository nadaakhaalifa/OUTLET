import { beforeEach, describe, expect, it } from "vitest";
import type { WishlistRepository } from "../domain/ports";
import type { Wishlist, WishlistItem } from "../domain/types";

export interface WishlistRepoContext {
  readonly repo: WishlistRepository;
  /** Makes the user exist where the store enforces the FK (Postgres); no-op in memory. */
  ensureUser(userId: string): Promise<void>;
}

export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P = (n: number): string => `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;
const T0 = 1_800_000_000_000;
const HASH = "ab".repeat(32);

const list = (n: number, userId: string, over: Partial<Wishlist> = {}): Wishlist => ({
  id: U(100 + n),
  userId,
  intent: "need",
  title: `list ${n}`,
  targetDate: null,
  budget: null,
  giftFor: null,
  coolOffEnabled: false,
  share: null,
  createdAtMs: T0 + n * 1000,
  updatedAtMs: T0 + n * 1000,
  ...over,
});

const item = (n: number, listId: string, userId: string, over: Partial<WishlistItem> = {}): WishlistItem => ({
  id: U(500 + n),
  wishlistId: listId,
  userId,
  productId: P(n),
  skuPref: null,
  addedPrice: { amount: 12_345n, currency: "EGP" },
  note: null,
  coolOffUntilMs: null,
  addedAtMs: T0 + n * 10,
  ...over,
});

/** `updatedAtMs` is owned by the store after `save` (DB trigger), so it is excluded from equality. */
const sameList = (a: Wishlist | null): unknown => (a === null ? null : { ...a, updatedAtMs: 0 });

/** Behaviour every WishlistRepository must have. Run against in-memory and Kysely/PGlite. */
export function describeWishlistRepositoryContract(name: string, make: () => Promise<WishlistRepoContext>): void {
  describe(`WishlistRepository contract: ${name}`, () => {
    let c: WishlistRepoContext;
    beforeEach(async () => {
      c = await make();
      await c.ensureUser(U(1));
      await c.ensureUser(U(2));
    });

    it("round-trips every list field including bigint budget and gift data", async () => {
      const big = 9_007_199_254_740_993n; // above Number.MAX_SAFE_INTEGER
      const l = list(1, U(1), {
        intent: "gift_for_someone",
        title: "Sara's birthday",
        targetDate: "2027-02-01",
        budget: { amount: big, currency: "EGP" },
        giftFor: { nickname: "Sara", occasion: "birthday", date: "2027-02-10" },
      });
      await c.repo.insert(l);
      expect(await c.repo.get(l.id)).toEqual(l);
      expect((await c.repo.get(l.id))?.budget?.amount).toBe(big);
      expect(await c.repo.get(U(999))).toBeNull();
      expect(await c.repo.countByUser(U(1))).toBe(1);
      expect(await c.repo.countByUser(U(2))).toBe(0);
    });

    it("round-trips the share link and resolves it by hash exactly", async () => {
      const l = list(2, U(1), {
        share: { tokenHash: HASH, createdAtMs: T0 + 5, expiresAtMs: T0 + 86_400_000, revokedAtMs: null, hidePrices: true },
      });
      await c.repo.insert(l);
      expect(await c.repo.get(l.id)).toEqual(l);
      expect(await c.repo.findByShareHash(HASH)).toEqual(l);
      expect(await c.repo.findByShareHash("cd".repeat(32))).toBeNull();

      const rotated = { ...l, share: { ...l.share!, tokenHash: "01".repeat(32), revokedAtMs: T0 + 99 } };
      await c.repo.save(rotated);
      expect(await c.repo.findByShareHash(HASH)).toBeNull();
      expect(sameList(await c.repo.findByShareHash("01".repeat(32)))).toEqual(sameList(rotated));

      await c.repo.save({ ...rotated, share: null });
      expect((await c.repo.get(l.id))?.share).toBeNull();
    });

    it("save updates fields and ignores a list that does not exist", async () => {
      const l = list(3, U(1));
      await c.repo.insert(l);
      const next = { ...l, title: "renamed", intent: "want" as const, coolOffEnabled: true, updatedAtMs: T0 + 7 };
      await c.repo.save(next);
      expect(sameList(await c.repo.get(l.id))).toEqual(sameList(next));
      await c.repo.save(list(4, U(1)));
      expect(await c.repo.get(U(104))).toBeNull();
    });

    it("save never overwrites a list owned by another user", async () => {
      const l = list(5, U(2), { title: "bob private" });
      await c.repo.insert(l);
      await c.repo.save({ ...l, userId: U(1), title: "pwned" });
      expect((await c.repo.get(l.id))?.title).toBe("bob private");
      expect((await c.repo.get(l.id))?.userId).toBe(U(2));
    });

    it("a stale save cannot un-revoke a share link", async () => {
      const share = { tokenHash: HASH, createdAtMs: T0, expiresAtMs: null, revokedAtMs: null, hidePrices: false };
      const l = list(6, U(1), { share });
      await c.repo.insert(l);
      await c.repo.save({ ...l, share: { ...share, revokedAtMs: T0 + 1 } });
      await c.repo.save({ ...l, title: "stale rename" });
      const got = await c.repo.get(l.id);
      expect(got?.share?.revokedAtMs).not.toBeNull();
      expect(got?.title).toBe("stale rename");
    });

    it("pages by (createdAt desc, id desc) with a stable cursor, scoped to the owner", async () => {
      for (let n = 1; n <= 5; n += 1) await c.repo.insert(list(n, U(1)));
      await c.repo.insert(list(9, U(2)));
      const p1 = await c.repo.listByUser(U(1), { after: null, limit: 2 });
      expect(p1.map((x) => x.id)).toEqual([U(105), U(104)]);
      const last = p1[1]!;
      const p2 = await c.repo.listByUser(U(1), { after: { createdAtMs: last.createdAtMs, id: last.id }, limit: 10 });
      expect(p2.map((x) => x.id)).toEqual([U(103), U(102), U(101)]);
    });

    it("breaks createdAt ties by id descending", async () => {
      await c.repo.insert(list(1, U(1), { id: U(201), createdAtMs: T0 }));
      await c.repo.insert(list(2, U(1), { id: U(202), createdAtMs: T0 }));
      const all = await c.repo.listByUser(U(1), { after: null, limit: 10 });
      expect(all.map((x) => x.id)).toEqual([U(202), U(201)]);
      const rest = await c.repo.listByUser(U(1), { after: { createdAtMs: T0, id: U(202) }, limit: 10 });
      expect(rest.map((x) => x.id)).toEqual([U(201)]);
    });

    it("lists only lists with a target or gift date", async () => {
      await c.repo.insert(list(1, U(1)));
      await c.repo.insert(list(2, U(1), { targetDate: "2027-03-01" }));
      await c.repo.insert(
        list(3, U(1), { intent: "gift_for_someone", giftFor: { nickname: "Omar", occasion: null, date: "2027-04-01" } }),
      );
      const ids = (await c.repo.listWithDates()).map((l) => l.id).sort();
      expect(ids).toEqual([U(102), U(103)]);
    });

    it("stores items with exact bigint price, orders by addedAt and counts them", async () => {
      const l = list(1, U(1));
      await c.repo.insert(l);
      const big = 9_007_199_254_740_999n;
      const a = item(2, l.id, U(1), { addedPrice: { amount: big, currency: "EGP" }, note: "for Eid", skuPref: P(77), coolOffUntilMs: T0 + 86_400_000 });
      const b = item(1, l.id, U(1));
      await c.repo.insertItem(a);
      await c.repo.insertItem(b);
      expect(await c.repo.items(l.id)).toEqual([b, a]);
      expect((await c.repo.items(l.id))[1]?.addedPrice.amount).toBe(big);
      expect(await c.repo.itemCount(l.id)).toBe(2);
      expect(await c.repo.itemsByProduct(P(2))).toEqual([a]);
      expect(await c.repo.itemsByProduct(P(55))).toEqual([]);
    });

    it("deleteItem is scoped to its list and reports whether it removed a row", async () => {
      const l1 = list(1, U(1));
      const l2 = list(2, U(1));
      await c.repo.insert(l1);
      await c.repo.insert(l2);
      const it1 = item(1, l1.id, U(1));
      await c.repo.insertItem(it1);
      expect(await c.repo.deleteItem(l2.id, it1.id)).toBe(false);
      expect(await c.repo.deleteItem(l1.id, it1.id)).toBe(true);
      expect(await c.repo.deleteItem(l1.id, it1.id)).toBe(false);
    });

    it("clearCoolOff clears only that list's items", async () => {
      const l1 = list(1, U(1), { intent: "want", coolOffEnabled: true });
      const l2 = list(2, U(1), { intent: "want", coolOffEnabled: true });
      await c.repo.insert(l1);
      await c.repo.insert(l2);
      await c.repo.insertItem(item(1, l1.id, U(1), { coolOffUntilMs: T0 + 1 }));
      await c.repo.insertItem(item(2, l2.id, U(1), { coolOffUntilMs: T0 + 2 }));
      await c.repo.clearCoolOff(l1.id);
      expect((await c.repo.items(l1.id))[0]?.coolOffUntilMs).toBeNull();
      expect((await c.repo.items(l2.id))[0]?.coolOffUntilMs).toBe(T0 + 2);
    });

    it("claimAlert is true only for the first claim of a key", async () => {
      const l = list(1, U(1));
      await c.repo.insert(l);
      expect(await c.repo.claimAlert("price:p1:t", l.id)).toBe(true);
      expect(await c.repo.claimAlert("price:p1:t", l.id)).toBe(false);
      expect(await c.repo.claimAlert("price:p2:t", l.id)).toBe(true);
    });

    it("delete removes the list, its items and its alert keys", async () => {
      const l = list(1, U(1));
      await c.repo.insert(l);
      await c.repo.insertItem(item(1, l.id, U(1)));
      await c.repo.claimAlert("k", l.id);
      await c.repo.delete(l.id);
      expect(await c.repo.get(l.id)).toBeNull();
      expect(await c.repo.items(l.id)).toEqual([]);
      expect(await c.repo.itemsByProduct(P(1))).toEqual([]);
      expect(await c.repo.countByUser(U(1))).toBe(0);
      // the key is free again once the list is gone, for a new list
      const l2 = list(2, U(1));
      await c.repo.insert(l2);
      expect(await c.repo.claimAlert("k", l2.id)).toBe(true);
    });
  });
}
