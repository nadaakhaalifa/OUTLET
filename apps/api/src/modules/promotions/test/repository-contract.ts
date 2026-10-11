import { beforeEach, describe, expect, it } from "vitest";
import { money } from "../domain/bridge";
import type { PromotionRecord, PromotionRepository, RedemptionInput } from "../domain/ports";

export interface PromotionRepoContext {
  readonly repo: PromotionRepository;
  /** Makes the user exist where the store enforces the FK (Postgres); no-op in memory. */
  ensureUser(userId: string): Promise<void>;
}

export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const STORE_A = "00000000-0000-4000-a000-000000000001";
export const STORE_B = "00000000-0000-4000-a000-000000000002";
const T0 = 1_800_000_000_000;
const DAY = "2027-01-15";

let seq = 100;
export function record(over: Partial<PromotionRecord> = {}): PromotionRecord {
  seq += 1;
  return {
    id: U(seq),
    version: 1,
    owner: { kind: "platform" },
    scope: "order",
    value: { kind: "percent", percentBps: 1000 },
    code: `PROMO${seq}`,
    autoApply: false,
    funding: { platformPct: 100, sellerPct: 0 },
    targeting: { storeIds: [], skuIds: [], paymentMethods: [], plusOnly: false },
    minOrder: null,
    maxDiscount: null,
    perUserCap: null,
    perDayCap: null,
    totalBudget: null,
    startsAtMs: T0,
    endsAtMs: T0 + 30 * 86_400_000,
    status: "active",
    title: { ar: "خصم" },
    createdBy: U(9000),
    createdAtMs: T0 - 1000,
    updatedAtMs: T0 - 1000,
    ...over,
  };
}

const redeem = (p: PromotionRecord, over: Partial<RedemptionInput> = {}): RedemptionInput => ({
  promotionId: p.id,
  promotionVersion: p.version,
  userId: U(1),
  orderGroupId: U(7000 + (seq += 1)),
  amount: 10_000n,
  platformFunded: 6_000n,
  sellerFunded: 4_000n,
  dayKey: DAY,
  atMs: T0 + 1000,
  ...over,
});

/** Behaviour every PromotionRepository must have. Run against in-memory and Kysely/PGlite. */
export function describePromotionRepositoryContract(name: string, make: () => Promise<PromotionRepoContext>): void {
  describe(`PromotionRepository contract: ${name}`, () => {
    let c: PromotionRepoContext;
    beforeEach(async () => {
      c = await make();
      for (const n of [1, 2, 3]) await c.ensureUser(U(n));
    });

    it("round-trips every kind, including exact bigint piastres and localized titles", async () => {
      const big = 9_007_199_254_740_993n;
      const rows: PromotionRecord[] = [
        record({ value: { kind: "percent", percentBps: 2500 }, title: { ar: "خصم", en: "Discount" } }),
        record({ scope: "store", value: { kind: "fixed", amount: money(big) }, minOrder: money(big), maxDiscount: money(big - 1n), totalBudget: money(big + 1n) }),
        record({ scope: "item", value: { kind: "bogo", buyQty: 2, getQty: 1, getPercentBps: 5000 } }),
        record({
          value: {
            kind: "tiered",
            tiers: [
              { minSubtotal: money(100_000n), percentBps: 500 },
              { minSubtotal: money(big), percentBps: 1500 },
            ],
          },
        }),
        record({ scope: "shipping", value: { kind: "free_shipping" }, code: null, autoApply: true, perUserCap: 3, perDayCap: 9 }),
        record({
          owner: { kind: "store", storeId: STORE_A },
          funding: { platformPct: 0, sellerPct: 100 },
          targeting: { storeIds: [STORE_A], skuIds: [U(501), U(502)], paymentMethods: ["card", "fawry"], plusOnly: true },
        }),
      ];
      for (const r of rows) expect(await c.repo.insert(r)).toBe("created");
      for (const r of rows) {
        const got = await c.repo.get(r.id);
        expect(got).toEqual({ ...r, createdAtMs: got?.createdAtMs, updatedAtMs: got?.updatedAtMs });
      }
      expect(await c.repo.get(U(424242))).toBeNull();
      expect(await c.repo.get("not-a-uuid")).toBeNull();
    });

    it("codes are unique; any number of auto promotions can coexist", async () => {
      expect(await c.repo.insert(record({ code: "SAVE10" }))).toBe("created");
      expect(await c.repo.insert(record({ code: "SAVE10" }))).toBe("code_taken");
      expect(await c.repo.insert(record({ code: null, autoApply: true }))).toBe("created");
      expect(await c.repo.insert(record({ code: null, autoApply: true }))).toBe("created");
    });

    it("lists by owner in id order with a cursor", async () => {
      const a1 = record();
      const a2 = record();
      const a3 = record();
      const other = record({ owner: { kind: "store", storeId: STORE_B }, funding: { platformPct: 0, sellerPct: 100 } });
      const platform = record();
      for (const r of [a3, a1, other, a2, platform]) await c.repo.insert(r);
      const all = await c.repo.list({ owner: { kind: "platform" }, afterId: null, limit: 10 });
      expect(all.map((r) => r.id)).toEqual([a1, a2, a3, platform].map((r) => r.id).sort());
      const page1 = await c.repo.list({ owner: { kind: "platform" }, afterId: null, limit: 2 });
      const page2 = await c.repo.list({ owner: { kind: "platform" }, afterId: page1[1]?.id ?? null, limit: 2 });
      expect([...page1, ...page2].map((r) => r.id)).toEqual(all.map((r) => r.id));
      const mine = await c.repo.list({ owner: { kind: "store", storeId: STORE_B }, afterId: null, limit: 10 });
      expect(mine.map((r) => r.id)).toEqual([other.id]);
      expect(await c.repo.list({ owner: { kind: "store", storeId: STORE_A }, afterId: null, limit: 10 })).toEqual([]);
    });

    it("update is compare-and-set, bumps the version and touches only operational fields", async () => {
      const p = record({ status: "draft" });
      await c.repo.insert(p);
      const next = await c.repo.update(
        p.id,
        1,
        { status: "active", title: { ar: "جديد", en: "New" }, endsAtMs: T0 + 5 * 86_400_000, totalBudget: money(500_000n), maxDiscount: money(20_000n) },
        T0 + 10,
      );
      expect(next).not.toBe("stale");
      if (next === null || next === "stale") return;
      expect(next).toMatchObject({
        id: p.id,
        version: 2,
        status: "active",
        title: { ar: "جديد", en: "New" },
        endsAtMs: T0 + 5 * 86_400_000,
        totalBudget: money(500_000n),
        maxDiscount: money(20_000n),
        value: p.value,
        funding: p.funding,
        code: p.code,
      });
      expect(await c.repo.update(p.id, 1, { status: "paused" }, T0 + 20)).toBe("stale");
      expect(await c.repo.update(U(424242), 1, { status: "paused" }, T0 + 20)).toBeNull();
      expect((await c.repo.get(p.id))?.status).toBe("active");
      // clearing the english title is allowed by replacing the whole title
      const t = await c.repo.update(p.id, 2, { title: { ar: "فقط" } }, T0 + 30);
      expect(t).toMatchObject({ title: { ar: "فقط" }, version: 3 });
    });

    it("candidates: live window, auto scope by store, code match, no drafts or ended", async () => {
      const autoPlatform = record({ code: null, autoApply: true });
      const autoA = record({ code: null, autoApply: true, owner: { kind: "store", storeId: STORE_A }, funding: { platformPct: 0, sellerPct: 100 } });
      const autoB = record({ code: null, autoApply: true, owner: { kind: "store", storeId: STORE_B }, funding: { platformPct: 0, sellerPct: 100 } });
      const coded = record({ code: "HELLO" });
      const codedStore = record({ code: "STORECODE", owner: { kind: "store", storeId: STORE_B }, funding: { platformPct: 0, sellerPct: 100 } });
      const draft = record({ code: "DRAFTY", status: "draft" });
      const ended = record({ code: "ENDEDX", status: "ended" });
      const paused = record({ code: null, autoApply: true, status: "paused" });
      const future = record({ code: "FUTURE", startsAtMs: T0 + 1000 });
      const edge = record({ code: "EDGE1", startsAtMs: T0, endsAtMs: T0 + 500 });
      for (const r of [autoPlatform, autoA, autoB, coded, codedStore, draft, ended, paused, future, edge]) await c.repo.insert(r);
      const ids = async (atMs: number, storeIds: string[], codes: string[]) =>
        (await c.repo.candidates({ atMs, storeIds, codes })).map((r) => r.id).sort();
      expect(await ids(T0 + 10, [STORE_A], ["HELLO", "DRAFTY", "ENDEDX", "FUTURE"])).toEqual(
        [autoPlatform.id, autoA.id, coded.id].sort(),
      );
      // edge code was not requested; start boundary is inclusive, end boundary exclusive
      expect(await ids(T0, [], ["EDGE1"])).toEqual([autoPlatform.id, edge.id].sort());
      expect(await ids(T0 + 500, [], ["EDGE1"])).toEqual([autoPlatform.id]);
      // a store-owned code is returned even if the store is not in the bag (the engine reports it)
      expect(await ids(T0 + 10, [], ["STORECODE"])).toEqual([autoPlatform.id, codedStore.id].sort());
      expect(await ids(T0 + 1000, [], ["FUTURE"])).toEqual([autoPlatform.id, future.id].sort());
    });

    it("usage counts live redemptions per user, per day and spend", async () => {
      const p = record();
      await c.repo.insert(p);
      const g = (n: number) => U(8000 + n);
      expect(
        await c.repo.recordRedemptions([
          redeem(p, { orderGroupId: g(1), userId: U(1), amount: 10_000n, platformFunded: 10_000n, sellerFunded: 0n }),
        ]),
      ).toEqual({ kind: "recorded", recorded: 1, existing: 0 });
      await c.repo.recordRedemptions([redeem(p, { orderGroupId: g(2), userId: U(2), dayKey: "2027-01-16", amount: 500n, platformFunded: 500n, sellerFunded: 0n })]);
      const u1 = (await c.repo.usage([p.id], U(1), DAY)).get(p.id);
      expect(u1).toEqual({ userRedemptions: 1, dayRedemptions: 1, spent: 10_500n });
      const u2 = (await c.repo.usage([p.id], U(2), "2027-01-16")).get(p.id);
      expect(u2).toEqual({ userRedemptions: 1, dayRedemptions: 1, spent: 10_500n });
      const none = await c.repo.usage([p.id, U(999999)], U(3), DAY);
      expect(none.get(p.id)).toEqual({ userRedemptions: 0, dayRedemptions: 1, spent: 10_500n });
      expect(none.get(U(999999))).toEqual({ userRedemptions: 0, dayRedemptions: 0, spent: 0n });
    });

    it("recordRedemptions is idempotent per promotion and order group", async () => {
      const p = record({ perUserCap: 1 });
      await c.repo.insert(p);
      const r = redeem(p, { orderGroupId: U(8100) });
      expect(await c.repo.recordRedemptions([r])).toEqual({ kind: "recorded", recorded: 1, existing: 0 });
      // replaying the same order group is a success even though the per-user cap is already used
      expect(await c.repo.recordRedemptions([r])).toEqual({ kind: "recorded", recorded: 0, existing: 1 });
      expect((await c.repo.usage([p.id], U(1), DAY)).get(p.id)?.userRedemptions).toBe(1);
    });

    it("enforces per-user, per-day and budget caps, all or nothing", async () => {
      const perUser = record({ perUserCap: 1 });
      const perDay = record({ perDayCap: 1 });
      const budget = record({ totalBudget: money(15_000n) });
      const free = record();
      for (const p of [perUser, perDay, budget, free]) await c.repo.insert(p);
      const g = (n: number) => U(8200 + n);
      expect((await c.repo.recordRedemptions([redeem(perUser, { orderGroupId: g(1) })])).kind).toBe("recorded");
      expect(await c.repo.recordRedemptions([redeem(perUser, { orderGroupId: g(2) })])).toEqual({
        kind: "rejected",
        promotionId: perUser.id,
        reason: "cap_reached",
      });
      // another user is fine for the per-user cap
      expect((await c.repo.recordRedemptions([redeem(perUser, { orderGroupId: g(3), userId: U(2) })])).kind).toBe("recorded");
      expect((await c.repo.recordRedemptions([redeem(perDay, { orderGroupId: g(4) })])).kind).toBe("recorded");
      expect(await c.repo.recordRedemptions([redeem(perDay, { orderGroupId: g(5), userId: U(2) })])).toMatchObject({
        reason: "cap_reached",
      });
      expect((await c.repo.recordRedemptions([redeem(perDay, { orderGroupId: g(6), dayKey: "2027-01-16" })])).kind).toBe("recorded");
      expect((await c.repo.recordRedemptions([redeem(budget, { orderGroupId: g(7), amount: 10_000n, platformFunded: 10_000n, sellerFunded: 0n })])).kind).toBe("recorded");
      expect(
        await c.repo.recordRedemptions([redeem(budget, { orderGroupId: g(8), amount: 5_001n, platformFunded: 5_001n, sellerFunded: 0n })]),
      ).toEqual({ kind: "rejected", promotionId: budget.id, reason: "budget_exhausted" });
      expect((await c.repo.recordRedemptions([redeem(budget, { orderGroupId: g(9), amount: 5_000n, platformFunded: 5_000n, sellerFunded: 0n })])).kind).toBe("recorded");
      // all or nothing: the first row would pass but the second fails, so neither is recorded
      const og = g(10);
      const out = await c.repo.recordRedemptions([redeem(free, { orderGroupId: og }), redeem(perUser, { orderGroupId: og })]);
      expect(out.kind).toBe("rejected");
      expect((await c.repo.usage([free.id], U(1), DAY)).get(free.id)?.userRedemptions).toBe(0);
      expect(await c.repo.recordRedemptions([redeem(record(), { orderGroupId: g(11) })])).toMatchObject({
        reason: "not_found",
      });
    });

    it("reinstating an order group frees its caps and spend", async () => {
      const p = record({ perUserCap: 1, totalBudget: money(10_000n) });
      await c.repo.insert(p);
      const og = U(8300);
      await c.repo.recordRedemptions([redeem(p, { orderGroupId: og, platformFunded: 10_000n, sellerFunded: 0n })]);
      expect(await c.repo.recordRedemptions([redeem(p, { orderGroupId: U(8301) })])).toMatchObject({ kind: "rejected" });
      expect(await c.repo.reinstate(og, T0 + 5)).toBe(1);
      expect(await c.repo.reinstate(og, T0 + 6)).toBe(0);
      expect(await c.repo.reinstate(U(8399), T0 + 6)).toBe(0);
      expect((await c.repo.usage([p.id], U(1), DAY)).get(p.id)).toEqual({ userRedemptions: 0, dayRedemptions: 0, spent: 0n });
      expect((await c.repo.recordRedemptions([redeem(p, { orderGroupId: U(8302), amount: 10_000n, platformFunded: 10_000n, sellerFunded: 0n })])).kind).toBe("recorded");
    });
  });
}
