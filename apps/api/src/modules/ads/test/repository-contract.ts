import { describe, expect, it } from "vitest";
import type { Campaign } from "../domain/bridge";
import type { AdsStore, BidRecord, ClickRecord, ImpressionRecord } from "../domain/ports";

export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const T0 = Date.parse("2026-04-15T09:00:00Z");
export const DAY_KEY = "2026-04-15";
export const HASH = (c: string): string => c.repeat(64).slice(0, 64);
export const STORE = U(9001);

export const campaign = (id: string, over: Partial<Campaign> = {}): Campaign => ({
  id,
  storeId: STORE,
  name: "Summer dresses",
  status: "ACTIVE",
  dailyBudget: 50_000n,
  maxCpc: 1_000n,
  keywords: ["dress"],
  categories: [],
  startsAtMs: T0 - 1_000,
  endsAtMs: null,
  createdAtMs: T0,
  updatedAtMs: T0,
  ...over,
});
export const bid = (campaignId: string, productId: string, amount = 500n): BidRecord => ({ campaignId, productId, bid: amount, createdAtMs: T0 });
export const impression = (id: string, campaignId: string, productId: string, over: Partial<ImpressionRecord> = {}): ImpressionRecord => ({
  id,
  campaignId,
  storeId: STORE,
  productId,
  position: 0,
  queryHash: HASH("q"),
  sessionHash: HASH("s"),
  atMs: T0,
  ...over,
});
export const click = (id: string, jti: string, campaignId: string, productId: string, over: Partial<ClickRecord> = {}): ClickRecord => ({
  id,
  tokenJti: jti,
  campaignId,
  storeId: STORE,
  productId,
  impressionId: U(600),
  sessionHash: HASH("s"),
  valid: true,
  invalidReason: null,
  cost: 400n,
  dayKey: DAY_KEY,
  atMs: T0 + 5_000,
  postedEntryId: null,
  creditedBack: 0n,
  ...over,
});

export interface ContractContext {
  readonly store: AdsStore;
  outboxCount(): Promise<number>;
  /** Kysely only: rows below are checked against the database constraint. */
  topUpBalance(): Promise<bigint>;
}

/** One behavioural contract the in-memory and the Kysely stores must both honour. */
export function describeAdsStoreContract(name: string, fresh: () => Promise<ContractContext>): void {
  describe(`AdsStore contract: ${name}`, () => {
    const fund = async (c: ContractContext, net: bigint, id = U(300)): Promise<void> => {
      await c.store.insertTopUp({
        id,
        storeId: STORE,
        net,
        vat: net / 100n * 14n,
        gross: net + net / 100n * 14n,
        status: "PENDING_PAYMENT",
        intentRef: null,
        idempotencyKey: `k-${id}`,
        createdAtMs: T0,
        creditedAtMs: null,
      });
      await c.store.creditTopUp(id, T0, []);
    };

    it("stores a campaign with bids and lists it by store, newest first", async () => {
      const c = await fresh();
      await c.store.insertCampaign(campaign(U(100)), [bid(U(100), U(700)), bid(U(100), U(701), 600n)]);
      await c.store.insertCampaign(campaign(U(101), { createdAtMs: T0 + 10 }), [bid(U(101), U(702))]);
      expect((await c.store.listCampaigns(STORE, 10)).map((x) => x.id)).toEqual([U(101), U(100)]);
      expect((await c.store.listBids(U(100))).map((b) => [b.productId, b.bid])).toEqual([[U(700), 500n], [U(701), 600n]]);
      expect((await c.store.getCampaign(U(100)))?.keywords).toEqual(["dress"]);
      expect(await c.store.getCampaign(U(999))).toBeNull();
    });

    it("updates fields and replaces bids atomically", async () => {
      const c = await fresh();
      await c.store.insertCampaign(campaign(U(100)), [bid(U(100), U(700))]);
      const n = await c.store.updateCampaign(U(100), { name: "Winter", dailyBudget: 70_000n }, [bid(U(100), U(703), 900n)], T0 + 50);
      expect(n?.name).toBe("Winter");
      expect(n?.dailyBudget).toBe(70_000n);
      expect((await c.store.listBids(U(100))).map((b) => b.productId)).toEqual([U(703)]);
    });

    it("changes status by compare-and-set and writes events in the same call", async () => {
      const c = await fresh();
      await c.store.insertCampaign(campaign(U(100)), [bid(U(100), U(700))]);
      const ev = [{ type: "ad.campaign_status_changed" as const, aggregateType: "ad_campaign" as const, aggregateId: U(100), payload: { to: "PAUSED" } }];
      expect(await c.store.setStatus(U(100), "PAUSED", "ACTIVE", T0, ev)).toBeNull();
      expect((await c.store.setStatus(U(100), "ACTIVE", "PAUSED", T0, ev))?.status).toBe("PAUSED");
      expect(await c.outboxCount()).toBe(1);
    });

    it("credits a top-up exactly once and is idempotent on (store, key)", async () => {
      const c = await fresh();
      const rec = {
        id: U(300),
        storeId: STORE,
        net: 10_000n,
        vat: 1_400n,
        gross: 11_400n,
        status: "PENDING_PAYMENT" as const,
        intentRef: null,
        idempotencyKey: "same",
        createdAtMs: T0,
        creditedAtMs: null,
      };
      expect((await c.store.insertTopUp(rec)).kind).toBe("created");
      expect((await c.store.insertTopUp({ ...rec, id: U(301) })).kind).toBe("duplicate");
      const first = await c.store.creditTopUp(U(300), T0, []);
      const again = await c.store.creditTopUp(U(300), T0, []);
      expect(first).toMatchObject({ kind: "credited", balance: 10_000n });
      expect(again).toMatchObject({ kind: "replayed", balance: 10_000n });
      expect(await c.store.getBalance(STORE)).toBe(10_000n);
    });

    it("lists only ACTIVE campaigns inside their window, with today's spend and the balance", async () => {
      const c = await fresh();
      await fund(c, 20_000n);
      await c.store.insertCampaign(campaign(U(100)), [bid(U(100), U(700))]);
      await c.store.insertCampaign(campaign(U(101), { startsAtMs: T0 + DAY_MS }), [bid(U(101), U(701))]);
      await c.store.insertCampaign(campaign(U(102), { status: "PAUSED" }), [bid(U(102), U(702))]);
      await c.store.insertCampaign(campaign(U(103), { endsAtMs: T0 - 1 }), [bid(U(103), U(703))]);
      const s = await c.store.listServable(T0, DAY_KEY);
      expect(s.map((x) => x.campaign.id)).toEqual([U(100)]);
      expect(s[0]).toMatchObject({ spentToday: 0n, balance: 20_000n, bid: 500n });
    });

    it("bills a valid click against the daily budget and the balance, never below zero", async () => {
      const c = await fresh();
      await fund(c, 1_000n);
      await c.store.insertCampaign(campaign(U(100), { dailyBudget: 800n, maxCpc: 400n }), [bid(U(100), U(700))]);
      await c.store.recordImpressions([impression(U(600), U(100), U(700))]);
      const a = await c.store.billClick(click(U(401), "jti-aaaaaaaa", U(100), U(700)), { dailyBudget: 800n }, []);
      const b = await c.store.billClick(click(U(402), "jti-bbbbbbbb", U(100), U(700)), { dailyBudget: 800n }, []);
      const over = await c.store.billClick(click(U(403), "jti-cccccccc", U(100), U(700)), { dailyBudget: 800n }, []);
      expect(a.kind).toBe("billed");
      expect(b.kind).toBe("billed");
      expect(over).toMatchObject({ kind: "rejected", click: { valid: false, invalidReason: "budget_exhausted", cost: 0n } });
      expect(await c.store.getBalance(STORE)).toBe(200n);
      const s = await c.store.listServable(T0, DAY_KEY);
      expect(s[0]?.spentToday).toBe(800n);
    });

    it("rejects with no_balance when the prepaid balance is short even though the budget has room", async () => {
      const c = await fresh();
      await fund(c, 300n);
      await c.store.insertCampaign(campaign(U(100)), [bid(U(100), U(700))]);
      const r = await c.store.billClick(click(U(401), "jti-aaaaaaaa", U(100), U(700)), { dailyBudget: 50_000n }, []);
      expect(r).toMatchObject({ kind: "rejected", click: { invalidReason: "no_balance" } });
      expect(await c.store.getBalance(STORE)).toBe(300n);
    });

    it("bills a replayed token once", async () => {
      const c = await fresh();
      await fund(c, 5_000n);
      await c.store.insertCampaign(campaign(U(100)), [bid(U(100), U(700))]);
      const a = await c.store.billClick(click(U(401), "jti-replayed1", U(100), U(700)), { dailyBudget: 50_000n }, []);
      const b = await c.store.billClick(click(U(402), "jti-replayed1", U(100), U(700)), { dailyBudget: 50_000n }, []);
      expect(a.kind).toBe("billed");
      expect(b.kind).toBe("duplicate");
      expect(await c.store.getBalance(STORE)).toBe(4_600n);
    });

    it("computes click signals per session and credits a click back exactly once", async () => {
      const c = await fresh();
      await fund(c, 5_000n);
      await c.store.insertCampaign(campaign(U(100)), [bid(U(100), U(700))]);
      await c.store.billClick(click(U(401), "jti-aaaaaaaa", U(100), U(700)), { dailyBudget: 50_000n }, []);
      const sig = await c.store.clickSignals({
        sessionHash: HASH("s"),
        campaignId: U(100),
        productId: U(700),
        dayKey: DAY_KEY,
        windowSinceMs: T0,
        minuteSinceMs: T0,
      });
      expect(sig).toEqual({ validInWindow: 1, clicksLastMinute: 1, campaignClicksToday: 1 });
      expect((await c.store.creditBack(U(401), T0)).kind).toBe("credited");
      expect((await c.store.creditBack(U(401), T0)).kind).toBe("replayed");
      expect(await c.store.getBalance(STORE)).toBe(5_000n);
      expect((await c.store.listServable(T0, DAY_KEY))[0]?.spentToday).toBe(0n);
      expect(await c.store.listUnposted(10)).toEqual([]);
    });

    it("tracks unposted clicks until marked posted and aggregates stats without credited-back spend", async () => {
      const c = await fresh();
      await fund(c, 5_000n);
      await c.store.insertCampaign(campaign(U(100)), [bid(U(100), U(700))]);
      await c.store.recordImpressions([impression(U(600), U(100), U(700)), impression(U(601), U(100), U(700), { atMs: T0 + 1 })]);
      await c.store.billClick(click(U(401), "jti-aaaaaaaa", U(100), U(700)), { dailyBudget: 50_000n }, []);
      await c.store.billClick(click(U(402), "jti-bbbbbbbb", U(100), U(700), { sessionHash: HASH("t") }), { dailyBudget: 50_000n }, []);
      expect((await c.store.listUnposted(10)).map((x) => x.id)).toEqual([U(401), U(402)]);
      await c.store.markPosted(U(401), "entry-1");
      expect((await c.store.listUnposted(10)).map((x) => x.id)).toEqual([U(402)]);
      await c.store.creditBack(U(402), T0);
      const s = await c.store.stats({ storeId: STORE, campaignId: null, fromMs: T0 - 1, toMs: T0 + DAY_MS });
      expect(s).toEqual({ impressions: 2, clicks: 2, spend: 400n });
      expect(await c.store.productIdsFor(STORE, null)).toEqual([U(700)]);
    });

    it("round-trips the platform config row", async () => {
      const c = await fresh();
      expect(await c.store.getConfig()).toBeNull();
      const cfg = {
        floorPrice: 150n,
        slots: 3,
        pricing: "first_price" as const,
        frequencyCapPerSessionDay: 4,
        clickTokenTtlMs: 600_000,
        clickDedupeWindowMs: 300_000,
        minDwellMs: 500,
        maxClicksPerSessionPerMinute: 6,
        maxClicksPerCampaignPerSessionDay: 2,
        botScoreBlockBps: 7_000,
        vatBps: 1_400n,
        minTopUp: 20_000n,
        maxTopUp: 50_000_000n,
      };
      await c.store.putConfig(cfg, U(21));
      expect(await c.store.getConfig()).toEqual(cfg);
    });
  });
}

const DAY_MS = 86_400_000;
