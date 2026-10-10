import { describe, expect, it } from "vitest";
import type { ClaimStore, EnforcementStore, PriceEventStore } from "../domain/ports";
import { PriceEventConflictError } from "../domain/ports";

export const U = (n: number): string => `0192f3a4-8000-7000-8000-${String(n).padStart(12, "0")}`;
export const T0 = 1_800_000_000_000;
export const DAY = 86_400_000;
export const STORE_A = U(9001);
export const STORE_B = U(9002);

export interface PriceIntegrityContractHarness {
  readonly events: PriceEventStore;
  readonly claims: ClaimStore;
  readonly enforcement: EnforcementStore;
  close(): Promise<void>;
}

const ev = (n: number, sku: number, store: string, price: bigint, at: number, key = `k${n}`) => ({
  id: U(100 + n),
  skuId: U(sku),
  storeId: store,
  priceAmount: price,
  validFromMs: at,
  source: "seller" as const,
  actorId: U(7),
  idempotencyKey: key,
});

/** One suite, run against every adapter (in-memory and Kysely/PGlite). */
export function describePriceIntegrityContract(name: string, make: () => Promise<PriceIntegrityContractHarness>): void {
  describe(`price-integrity persistence contract: ${name}`, () => {
    it("keeps history in valid_from order", async () => {
      const h = await make();
      await h.events.append(ev(1, 1, STORE_A, 100_000n, T0 + 123));
      await h.events.append(ev(2, 1, STORE_A, 90_000n, T0 + 5 * DAY + 7));
      const hist = await h.events.history(U(1));
      expect(hist.map((e) => [e.priceAmount, e.validFromMs])).toEqual([
        [100_000n, T0 + 123],
        [90_000n, T0 + 5 * DAY + 7],
      ]);
      expect(hist[0]).toMatchObject({ skuId: U(1), source: "seller", actorId: U(7) });
      await h.close();
    });

    it("is idempotent on (sku, key) and rejects a reused key with another payload", async () => {
      const h = await make();
      const a = await h.events.append(ev(1, 1, STORE_A, 100_000n, T0, "same"));
      expect(a.created).toBe(true);
      const b = await h.events.append(ev(2, 1, STORE_A, 100_000n, T0, "same"));
      expect(b.created).toBe(false);
      expect(b.event.id).toBe(a.event.id);
      await expect(h.events.append(ev(3, 1, STORE_A, 55_000n, T0, "same"))).rejects.toMatchObject({ code: "idempotency_conflict" });
      expect(await h.events.history(U(1))).toHaveLength(1);
      await h.close();
    });

    it("rejects back-dated events and another store's SKU", async () => {
      const h = await make();
      await h.events.append(ev(1, 1, STORE_A, 100_000n, T0 + DAY));
      await expect(h.events.append(ev(2, 1, STORE_A, 90_000n, T0))).rejects.toBeInstanceOf(PriceEventConflictError);
      await expect(h.events.append(ev(3, 1, STORE_A, 90_000n, T0))).rejects.toMatchObject({ code: "out_of_order" });
      await expect(h.events.append(ev(4, 1, STORE_B, 90_000n, T0 + 2 * DAY))).rejects.toMatchObject({ code: "store_mismatch" });
      expect(await h.events.history(U(1))).toHaveLength(1);
      await h.close();
    });

    it("historyMany groups by sku and omits unknown ones; storeOf answers per sku", async () => {
      const h = await make();
      await h.events.append(ev(1, 1, STORE_A, 100n, T0));
      await h.events.append(ev(2, 2, STORE_B, 200n, T0));
      await h.events.append(ev(3, 2, STORE_B, 150n, T0 + DAY));
      const m = await h.events.historyMany([U(1), U(2), U(3), "not-a-uuid"]);
      expect([...m.keys()].sort()).toEqual([U(1), U(2)].sort());
      expect(m.get(U(2))?.map((e) => e.priceAmount)).toEqual([200n, 150n]);
      expect(await h.events.storeOf(U(1))).toBe(STORE_A);
      expect(await h.events.storeOf(U(2))).toBe(STORE_B);
      expect(await h.events.storeOf(U(3))).toBeNull();
      await h.close();
    });

    it("stores a claim once and counts it per store and window", async () => {
      const h = await make();
      const base = {
        skuId: U(1),
        storeId: STORE_A,
        status: "verified_discount" as const,
        priceAmount: 800n,
        vrpAmount: 1000n,
        discountPct: 20,
        evidenceIds: [U(101), U(102)],
        reason: null,
        computedAtMs: T0,
      };
      expect(await h.claims.record({ ...base, id: U(500) })).toBe(true);
      expect(await h.claims.record({ ...base, id: U(500) })).toBe(false);
      await h.claims.record({ ...base, id: U(501), status: "none", vrpAmount: null, discountPct: null, evidenceIds: [], reason: "not_a_reduction", computedAtMs: T0 + DAY });
      await h.claims.record({ ...base, id: U(502), storeId: STORE_B });
      expect(await h.claims.statsSince(STORE_A, T0)).toEqual({ evaluated: 2, verified: 1 });
      expect(await h.claims.statsSince(STORE_A, T0 + 1)).toEqual({ evaluated: 1, verified: 0 });
      expect(await h.claims.statsSince(STORE_B, T0)).toEqual({ evaluated: 1, verified: 1 });
      await h.close();
    });

    it("records enforcement once per dedupe key and tracks one open cross-channel finding per sku", async () => {
      const h = await make();
      const rec = (n: number, kind: "pre_drop_inflation" | "cross_channel_cheaper", sku: number, at: number, key: string) => ({
        id: U(600 + n),
        storeId: STORE_A,
        skuId: U(sku),
        kind,
        actions: [{ kind: "demote" as const, fixDeadlineMs: at + 48 * 3_600_000 }],
        violationsInWindow: n,
        dedupeKey: key,
        openedAtMs: at,
        resolvedAtMs: null,
      });
      expect(await h.enforcement.record(rec(1, "pre_drop_inflation", 1, T0, "a"))).toBe(true);
      expect(await h.enforcement.record(rec(2, "pre_drop_inflation", 1, T0, "a"))).toBe(false);
      expect(await h.enforcement.record(rec(3, "cross_channel_cheaper", 2, T0 + DAY, "b"))).toBe(true);
      expect(await h.enforcement.record(rec(4, "cross_channel_cheaper", 2, T0 + 2 * DAY, "c"))).toBe(false);
      expect(await h.enforcement.openCrossChannelSince(U(2))).toBe(T0 + DAY);
      expect(await h.enforcement.openCrossChannelCount(STORE_A)).toBe(1);
      expect(await h.enforcement.countSince(STORE_A, T0)).toBe(2);
      expect(await h.enforcement.countKindSince(STORE_A, "pre_drop_inflation", T0)).toBe(1);
      expect(await h.enforcement.resolveCrossChannel(U(2), T0 + 3 * DAY)).toBe(1);
      expect(await h.enforcement.openCrossChannelSince(U(2))).toBeNull();
      expect(await h.enforcement.resolveCrossChannel(U(2), T0 + 4 * DAY)).toBe(0);
      const recent = await h.enforcement.recent(STORE_A, 10);
      expect(recent.map((r) => r.dedupeKey)).toEqual(["b", "a"]);
      expect(recent[0]?.resolvedAtMs).toBe(T0 + 3 * DAY);
      expect(recent[0]?.actions).toEqual([{ kind: "demote", fixDeadlineMs: T0 + DAY + 48 * 3_600_000 }]);
      expect(await h.enforcement.recent(STORE_B, 10)).toEqual([]);
      await h.close();
    });
  });
}
