import { describe, expect, it } from "vitest";
import { sanitizePriceBlock } from "@outlet/domain";
import type { PriceBlockReader } from "../../catalog";
import { createPriceIntegrityDevFixtures } from "../adapters/in-memory";
import { PriceIntegrityError, PriceIntegrityService, claimIdFor } from "../application/service";
import { DAY, STORE_A, STORE_B, T0, U } from "./contract";

function setup() {
  const fx = createPriceIntegrityDevFixtures();
  let now = T0;
  let n = 0;
  const service = new PriceIntegrityService({
    ...fx,
    clock: { nowMs: () => now },
    ids: { uuidV7: () => U(1000 + (n += 1)) },
  });
  const at = (ms: number) => {
    now = ms;
  };
  let k = 0;
  const price = (sku: number, store: string, amount: bigint, ms: number) => {
    at(ms);
    return service.recordPriceChange({ skuId: U(sku), storeId: store, priceAmount: amount, source: "seller", actorId: U(7), idempotencyKey: `key-${(k += 1)}` });
  };
  return { fx, service, at, price };
}

describe("PriceIntegrityService", () => {
  it("satisfies the catalog PriceBlockReader port", async () => {
    const { service, price, at } = setup();
    const reader: PriceBlockReader = service;
    await price(1, STORE_A, 1_000n, T0);
    await price(1, STORE_A, 800n, T0 + 100 * DAY);
    at(T0 + 100 * DAY + 1);
    const m = await reader.blocks([U(1), U(404)]);
    expect([...m.keys()]).toEqual([U(1)]);
    const b = m.get(U(1));
    expect(b).toMatchObject({ badge: "verified_discount", discountPct: 20, referencePrice: { amount: 1_000n, currency: "EGP" } });
    expect(sanitizePriceBlock(b)).toEqual(b);
  });

  it("never shows a percentage for a new listing, and shows launch price", async () => {
    const { service, price, at } = setup();
    await price(1, STORE_A, 1_000n, T0);
    await price(1, STORE_A, 500n, T0 + 3 * DAY);
    at(T0 + 4 * DAY);
    const b = (await service.blocks([U(1)])).get(U(1));
    expect(b).toEqual({ badge: "launch_price", referencePrice: null, discountPct: null, claimId: b?.claimId ?? null });
  });

  it("raise then cut inside 30 days: no inflated claim, violation recorded once, badge ladder applies", async () => {
    const { service, price, fx } = setup();
    await price(1, STORE_A, 1_000n, T0);
    await price(1, STORE_A, 1_500n, T0 + 100 * DAY);
    const cut = await price(1, STORE_A, 1_200n, T0 + 110 * DAY);
    expect(cut.result.claimAllowed).toBe(false);
    expect(cut.result.reason).toBe("reference_not_above_price");
    expect(cut.actions).toEqual([{ kind: "remove_badge", days: 30, rankingPenalty: true }]);
    expect(await fx.enforcement.countSince(STORE_A, 0)).toBe(1);
    // replaying the same call changes nothing
    const again = await service.recordPriceChange({
      skuId: U(1), storeId: STORE_A, priceAmount: 1_200n, validFromMs: T0 + 110 * DAY, source: "seller", actorId: U(7), idempotencyKey: "key-3",
    });
    expect(again.created).toBe(false);
    expect(again.actions).toEqual([]);
    expect(await fx.enforcement.countSince(STORE_A, 0)).toBe(1);
  });

  it("an honest cut records a verified claim and no violation", async () => {
    const { price, fx } = setup();
    await price(1, STORE_A, 1_000n, T0);
    const cut = await price(1, STORE_A, 900n, T0 + 90 * DAY);
    expect(cut).toMatchObject({ created: true, actions: [] });
    expect(cut.result).toMatchObject({ status: "verified_discount", discountPct: 10, vrpAmount: 1_000n });
    expect(await fx.claims.statsSince(STORE_A, 0)).toEqual({ evaluated: 2, verified: 1 });
    expect(await fx.enforcement.countSince(STORE_A, 0)).toBe(0);
  });

  it("rejects non-positive prices and future start times", async () => {
    const { service } = setup();
    const base = { skuId: U(1), storeId: STORE_A, source: "seller" as const, actorId: null, idempotencyKey: "x" };
    await expect(service.recordPriceChange({ ...base, priceAmount: 0n })).rejects.toBeInstanceOf(PriceIntegrityError);
    await expect(service.recordPriceChange({ ...base, priceAmount: -5n })).rejects.toMatchObject({ code: "invalid_price" });
    await expect(service.recordPriceChange({ ...base, priceAmount: 5n, validFromMs: T0 + 1 })).rejects.toMatchObject({ code: "invalid_time" });
  });

  describe("cross-channel parity (external port)", () => {
    const ext = (cur: bigint, observedAtMs: number) => ({
      id: "ext-1", lowPriceAmount: cur, currentPriceAmount: cur, matchConfBp: 9_600, historyDays: 60, observedAtMs,
    });

    it("demotes, auto-pauses after 48h, and resolves when parity returns", async () => {
      const { service, price, fx, at } = setup();
      await price(1, STORE_A, 1_000n, T0);
      const t1 = T0 + 100 * DAY;
      fx.external.set(U(1), ext(700n, t1));
      const first = await price(1, STORE_A, 950n, t1);
      expect(first.result.crossChannelCheaper).toBe(true);
      expect(first.actions).toEqual([{ kind: "demote", fixDeadlineMs: t1 + 48 * 3_600_000 }]);
      expect(await fx.enforcement.openCrossChannelSince(U(1))).toBe(t1);

      const t2 = t1 + 49 * 3_600_000;
      fx.external.set(U(1), ext(700n, t2));
      const second = await price(1, STORE_A, 940n, t2);
      expect(second.actions.map((a) => a.kind)).toEqual(["demote", "auto_pause_sku"]);

      const t3 = t2 + 3_600_000;
      fx.external.set(U(1), ext(990n, t3));
      const third = await price(1, STORE_A, 930n, t3);
      expect(third.result.crossChannelCheaper).toBe(false);
      expect(await fx.enforcement.openCrossChannelSince(U(1))).toBeNull();
      at(t3);
      const trust = await service.trustForStore(STORE_A);
      expect(trust.openCrossChannelFindings).toBe(0);
      expect(trust.violations).toBe(1);
    });

    it("stale external evidence blocks the claim (fail closed) instead of ignoring it", async () => {
      const { service, price, fx, at } = setup();
      await price(1, STORE_A, 1_000n, T0);
      const t = T0 + 100 * DAY;
      await price(1, STORE_A, 700n, t);
      at(t);
      expect((await service.blocks([U(1)])).get(U(1))?.badge).toBe("verified_discount");
      fx.external.set(U(1), ext(900n, t - 73 * 3_600_000));
      const b = (await service.blocks([U(1)])).get(U(1));
      expect(b?.badge).toBe("none");
      expect(b?.discountPct).toBeNull();
    });
  });

  describe("reviewClaim", () => {
    it("corrects an inflated seller reference to the VRP and records claim_exceeds_vrp", async () => {
      const { service, price, fx } = setup();
      await price(1, STORE_A, 1_000n, T0);
      await price(1, STORE_A, 800n, T0 + 100 * DAY);
      const r = await service.reviewClaim({ skuId: U(1), storeId: STORE_A, claimedReferenceAmount: 2_000n });
      expect(r.corrected).toBe(true);
      expect(r.display.referencePrice).toEqual({ amount: 1_000n, currency: "EGP" });
      expect(r.actions).toEqual([{ kind: "auto_correct_display" }]);
      expect(await fx.enforcement.countKindSince(STORE_A, "claim_exceeds_vrp", 0)).toBe(1);
      const ok = await service.reviewClaim({ skuId: U(1), storeId: STORE_A, claimedReferenceAmount: 1_000n });
      expect(ok).toMatchObject({ corrected: false, actions: [] });
    });

    it("hides the discount when there is no evidence at all", async () => {
      const { service, price } = setup();
      await price(1, STORE_A, 1_000n, T0);
      const r = await service.reviewClaim({ skuId: U(1), storeId: STORE_A, claimedReferenceAmount: 1_500n });
      expect(r.display).toMatchObject({ discountPct: null, referencePrice: null });
      expect(r.actions).toEqual([{ kind: "hide_discount" }]);
    });

    it("three violations strip the verified badge", async () => {
      const { service, price } = setup();
      await price(1, STORE_A, 1_000n, T0);
      let last: readonly { kind: string }[] = [];
      for (const claimed of [1_100n, 1_200n, 1_300n]) {
        last = (await service.reviewClaim({ skuId: U(1), storeId: STORE_A, claimedReferenceAmount: claimed })).actions;
      }
      expect(last.map((a) => a.kind)).toEqual(["hide_discount", "strip_verified_badge"]);
    });
  });

  it("trust score reflects violations and is scoped to the store", async () => {
    const { service, price, at } = setup();
    await price(1, STORE_A, 1_000n, T0);
    await price(1, STORE_A, 1_500n, T0 + 100 * DAY);
    await price(1, STORE_A, 1_200n, T0 + 110 * DAY);
    await price(2, STORE_B, 500n, T0);
    at(T0 + 111 * DAY);
    const a = await service.trustForStore(STORE_A);
    const b = await service.trustForStore(STORE_B);
    expect(a).toMatchObject({ violations: 1, score: 90, band: "excellent", windowDays: 90 });
    expect(a.recent.map((r) => r.kind)).toEqual(["pre_drop_inflation"]);
    expect(b).toMatchObject({ violations: 0, score: 100, recent: [] });
  });

  it("evidence is hidden for unknown or inactive products and carries a 30-day history", async () => {
    const { service, price, fx, at } = setup();
    await price(1, STORE_A, 1_000n, T0);
    await price(1, STORE_A, 800n, T0 + 100 * DAY);
    at(T0 + 105 * DAY);
    expect(await service.evidenceForProduct(U(50))).toBeNull();
    fx.directory.set(U(50), { storeId: STORE_A, skuIds: [U(1), U(2)], active: false });
    expect(await service.evidenceForProduct(U(50))).toBeNull();
    fx.directory.set(U(50), { storeId: STORE_A, skuIds: [U(1), U(2)], active: true });
    const v = await service.evidenceForProduct(U(50));
    expect(v?.skus).toHaveLength(1);
    const sku = v?.skus[0];
    expect(sku?.lowest30dAmount).toBe(800n);
    expect(sku?.history.map((h) => h.priceAmount)).toEqual([1_000n, 800n]);
    expect(sku?.block).toMatchObject({ badge: "verified_discount", discountPct: 20 });
  });

  it("snapshot carries evidence ids for the order line", async () => {
    const { service, price, at } = setup();
    expect(await service.snapshotFor(U(1))).toBeNull();
    await price(1, STORE_A, 1_000n, T0);
    const cut = await price(1, STORE_A, 800n, T0 + 100 * DAY);
    at(T0 + 100 * DAY);
    const snap = await service.snapshotFor(U(1));
    expect(snap).toMatchObject({ claimType: "verified_discount", vrpAmount: 1_000n, discountPct: 20, priceAmount: 800n });
    expect(snap?.evidenceIds).toContain(cut.event.id);
  });

  it("claim ids are deterministic and uuid shaped", async () => {
    const { price } = setup();
    const o = await price(1, STORE_A, 1_000n, T0);
    expect(claimIdFor(U(1), o.result)).toBe(claimIdFor(U(1), o.result));
    expect(claimIdFor(U(1), o.result)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(claimIdFor(U(2), o.result)).not.toBe(claimIdFor(U(1), o.result));
  });
});
