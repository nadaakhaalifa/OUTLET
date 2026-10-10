import { beforeEach, describe, expect, it } from "vitest";
import type { SavedSearchRecord, SavedSearchRepository } from "../domain/ports";

export interface SavedContext {
  readonly repo: SavedSearchRepository;
  /** Makes the user exist where the store enforces the FK (Postgres); no-op in memory. */
  ensureUser(userId: string): Promise<void>;
}

export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ID = (n: number): string => `00000000-0000-4000-d000-${String(n).padStart(12, "0")}`;
const T0 = 1_800_000_000_000;

const rec = (n: number, userId: string, over: Partial<SavedSearchRecord> = {}): SavedSearchRecord => ({
  id: ID(n),
  userId,
  name: `search ${n}`,
  query: "white dress",
  filter: { priceMax: 150_000n, colors: ["white"] },
  alertEnabled: false,
  lastRunAtMs: null,
  createdAtMs: T0 + n * 1000,
  updatedAtMs: T0 + n * 1000,
  ...over,
});

const shape = (r: SavedSearchRecord | null): unknown => (r === null ? null : { ...r, updatedAtMs: 0 });

export function describeSavedSearchContract(name: string, make: () => Promise<SavedContext>): void {
  describe(`SavedSearchRepository contract: ${name}`, () => {
    let c: SavedContext;
    beforeEach(async () => {
      c = await make();
      await c.ensureUser(U(1));
      await c.ensureUser(U(2));
    });

    it("creates and reads back, including bigint money in the filter", async () => {
      const r = rec(1, U(1), { filter: { priceMax: 9_007_199_254_740_993n, world: "local", colors: ["red"] } });
      await c.repo.create(r);
      expect(shape(await c.repo.get(U(1), r.id))).toEqual(shape(r));
      expect(await c.repo.count(U(1))).toBe(1);
    });

    it("scopes every operation to the owner: foreign rows behave as missing", async () => {
      const r = rec(1, U(1));
      await c.repo.create(r);
      expect(await c.repo.get(U(2), r.id)).toBeNull();
      expect(await c.repo.update(U(2), r.id, { name: "x" }, T0)).toBeNull();
      expect(await c.repo.delete(U(2), r.id)).toBe(false);
      expect(await c.repo.list(U(2), 10, null)).toEqual([]);
      expect(await c.repo.count(U(2))).toBe(0);
      expect(shape(await c.repo.get(U(1), r.id))).toEqual(shape(r));
    });

    it("updates only the supplied fields", async () => {
      const r = rec(1, U(1));
      await c.repo.create(r);
      const u = await c.repo.update(U(1), r.id, { alertEnabled: true }, T0 + 5);
      expect(u?.alertEnabled).toBe(true);
      expect(u?.name).toBe(r.name);
      expect(u?.filter).toEqual(r.filter);
      const v = await c.repo.update(U(1), r.id, { name: "  renamed ", filter: { newArrivals: true } }, T0 + 6);
      expect(v?.name).toBe("renamed");
      expect(v?.filter).toEqual({ newArrivals: true });
      expect(v?.alertEnabled).toBe(true);
    });

    it("deletes once", async () => {
      const r = rec(1, U(1));
      await c.repo.create(r);
      expect(await c.repo.delete(U(1), r.id)).toBe(true);
      expect(await c.repo.delete(U(1), r.id)).toBe(false);
      expect(await c.repo.get(U(1), r.id)).toBeNull();
    });

    it("lists newest first with a stable cursor", async () => {
      for (let i = 1; i <= 5; i += 1) await c.repo.create(rec(i, U(1)));
      const first = await c.repo.list(U(1), 2, null);
      expect(first.map((x) => x.id)).toEqual([ID(5), ID(4)]);
      const last = first[first.length - 1];
      const second = await c.repo.list(U(1), 2, last === undefined ? null : { createdAtMs: last.createdAtMs, id: last.id });
      expect(second.map((x) => x.id)).toEqual([ID(3), ID(2)]);
      const third = await c.repo.list(U(1), 10, { createdAtMs: T0 + 2000, id: ID(2) });
      expect(third.map((x) => x.id)).toEqual([ID(1)]);
    });

    it("breaks created_at ties by id descending", async () => {
      await c.repo.create(rec(1, U(1), { createdAtMs: T0 }));
      await c.repo.create(rec(2, U(1), { createdAtMs: T0 }));
      expect((await c.repo.list(U(1), 10, null)).map((x) => x.id)).toEqual([ID(2), ID(1)]);
    });
  });
}
