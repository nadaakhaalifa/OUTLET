import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { sumByCurrency } from "../ledger";
import {
  CAMPAIGN_STATUSES,
  CAMPAIGN_TRANSITIONS,
  DEFAULT_ADS_CONFIG,
  InvalidCampaignTransitionError,
  cairoDayKey,
  classifyClick,
  clickPostings,
  creditBackPostings,
  matchesTargeting,
  quoteTopUp,
  runAuction,
  startOfCairoDayMs,
  sumStats,
  topUpPostings,
  transitionCampaign,
  validateCampaignDraft,
  viewStats,
  type AuctionCandidate,
  type CampaignEvent,
  type ClickSignals,
} from "./index";

const cfg = DEFAULT_ADS_CONFIG;

const cand = (n: number, over: Partial<AuctionCandidate> = {}): AuctionCandidate => ({
  campaignId: `c${String(n).padStart(3, "0")}`,
  storeId: `s${n}`,
  productId: `p${String(n).padStart(3, "0")}`,
  bid: 500n,
  maxCpc: 10_000n,
  bidAtMs: 1_000 + n,
  relevanceBp: 10_000,
  sellerHealthBp: 10_000,
  priceTrustBp: 10_000,
  remainingDaily: 100_000n,
  balance: 100_000n,
  ...over,
});

const arbCand = fc
  .record({
    n: fc.integer({ min: 0, max: 40 }),
    storeN: fc.integer({ min: 0, max: 4 }),
    bid: fc.bigInt({ min: 1n, max: 3_000n }),
    maxCpc: fc.bigInt({ min: 1n, max: 3_000n }),
    bidAtMs: fc.integer({ min: 0, max: 10 }),
    rel: fc.integer({ min: 0, max: 10_000 }),
    health: fc.integer({ min: 0, max: 10_000 }),
    trust: fc.integer({ min: 0, max: 10_000 }),
    daily: fc.bigInt({ min: -50n, max: 5_000n }),
    bal: fc.bigInt({ min: -50n, max: 5_000n }),
  })
  .map((r) =>
    cand(r.n, {
      storeId: `s${r.storeN}`,
      bid: r.bid,
      maxCpc: r.maxCpc,
      bidAtMs: r.bidAtMs,
      relevanceBp: r.rel,
      sellerHealthBp: r.health,
      priceTrustBp: r.trust,
      remainingDaily: r.daily,
      balance: r.bal,
      // two candidates may share a campaign id (same campaign, several products)
      campaignId: `c${r.n % 12}`,
    }),
  );
const arbCands = fc.array(arbCand, { maxLength: 25 }).map((a) => {
  // unique (campaign, product): products are keyed by n, campaigns by n % 12
  const seen = new Set<string>();
  return a.filter((c) => (seen.has(c.productId) ? false : (seen.add(c.productId), true)));
});

describe("auction (spec 10)", () => {
  it("second price: the winner pays what the runner-up needs to be beaten, not its own bid", () => {
    const r = runAuction([cand(1, { bid: 900n }), cand(2, { bid: 600n })], { floorPrice: 100n, slots: 1, pricing: "gsp" });
    expect(r.winners).toHaveLength(1);
    expect(r.winners[0]?.campaignId).toBe("c001");
    expect(r.winners[0]?.price).toBe(600n);
  });

  it("first price charges the full bid (the comparison option)", () => {
    const r = runAuction([cand(1, { bid: 900n }), cand(2, { bid: 600n })], { floorPrice: 100n, slots: 1, pricing: "first_price" });
    expect(r.winners[0]?.price).toBe(900n);
  });

  it("a lone bidder pays the floor", () => {
    const r = runAuction([cand(1, { bid: 900n })], { floorPrice: 250n, slots: 2, pricing: "gsp" });
    expect(r.winners[0]?.price).toBe(250n);
  });

  it("quality can beat a higher bid, and the price accounts for the quality ratio (rounded up)", () => {
    const hi = cand(1, { bid: 1_000n, relevanceBp: 5_000 }); // quality 0.5
    const lo = cand(2, { bid: 700n }); // quality 1.0
    const r = runAuction([hi, lo], { floorPrice: 100n, slots: 2, pricing: "gsp" });
    expect(r.winners.map((w) => w.campaignId)).toEqual(["c002", "c001"]);
    expect(r.winners[0]?.price).toBe(500n); // 1000 x 0.5 / 1.0
  });

  it("ties go to the earliest bid, then campaign id", () => {
    const a = cand(1, { bid: 500n, bidAtMs: 50 });
    const b = cand(2, { bid: 500n, bidAtMs: 10 });
    expect(runAuction([a, b], { floorPrice: 100n, slots: 1, pricing: "gsp" }).winners[0]?.campaignId).toBe("c002");
    const c = cand(3, { bid: 500n, bidAtMs: 10 });
    expect(runAuction([c, b], { floorPrice: 100n, slots: 1, pricing: "gsp" }).winners[0]?.campaignId).toBe("c002");
  });

  it("rejects exhausted budget, empty balance, below-floor bids and zero quality", () => {
    const r = runAuction(
      [
        cand(1, { remainingDaily: 50n }),
        cand(2, { balance: 0n }),
        cand(3, { bid: 10n }),
        cand(4, { relevanceBp: 0 }),
        cand(5),
      ],
      { floorPrice: 100n, slots: 5, pricing: "gsp" },
    );
    expect(r.winners.map((w) => w.campaignId)).toEqual(["c005"]);
    expect(r.rejected.map((x) => x.reason).sort()).toEqual(["below_floor", "budget_exhausted", "no_balance", "zero_quality"]);
  });

  it("two campaigns on the same product: only the best bid is served", () => {
    const r = runAuction([cand(1, { productId: "px", bid: 400n }), cand(2, { productId: "px", bid: 800n })], {
      floorPrice: 100n,
      slots: 2,
      pricing: "gsp",
    });
    expect(r.winners).toHaveLength(1);
    expect(r.winners[0]?.campaignId).toBe("c002");
    expect(r.rejected[0]?.reason).toBe("outbid_same_product");
  });

  it("the max CPC clamps the bid", () => {
    const r = runAuction([cand(1, { bid: 5_000n, maxCpc: 300n })], { floorPrice: 100n, slots: 1, pricing: "first_price" });
    expect(r.winners[0]?.price).toBe(300n);
  });

  it("PROPERTY: price never exceeds the bid, the campaign cap or goes below the floor", () => {
    fc.assert(
      fc.property(arbCands, fc.integer({ min: 0, max: 4 }), fc.constantFrom("gsp" as const, "first_price" as const), (cs, slots, pricing) => {
        const out = runAuction(cs, { floorPrice: 100n, slots, pricing });
        for (const w of out.winners) {
          const c = cs.find((x) => x.productId === w.productId);
          expect(c).toBeDefined();
          if (c === undefined) continue;
          const eff = c.bid < c.maxCpc ? c.bid : c.maxCpc;
          const cap = c.remainingDaily < c.balance ? c.remainingDaily : c.balance;
          expect(w.price <= c.bid).toBe(true);
          expect(w.price <= eff).toBe(true);
          expect(w.price <= cap).toBe(true);
          expect(w.price >= 100n).toBe(true);
        }
      }),
      { numRuns: 400 },
    );
  });

  it("PROPERTY: one campaign's winners together never exceed its remaining budget or balance", () => {
    fc.assert(
      fc.property(arbCands, (cs) => {
        const out = runAuction(cs, { floorPrice: 100n, slots: 6, pricing: "first_price" });
        const total = new Map<string, bigint>();
        for (const w of out.winners) total.set(w.campaignId, (total.get(w.campaignId) ?? 0n) + w.price);
        for (const [id, sum] of total) {
          const caps = cs.filter((x) => x.campaignId === id).map((x) => (x.remainingDaily < x.balance ? x.remainingDaily : x.balance));
          expect(sum <= caps.reduce((a, b) => (a > b ? a : b), 0n)).toBe(true);
        }
      }),
      { numRuns: 400 },
    );
  });

  it("PROPERTY: the result is independent of input order (deterministic tie-break)", () => {
    fc.assert(
      fc.property(arbCands, fc.integer({ min: 1, max: 4 }), (cs, slots) => {
        const a = runAuction(cs, { floorPrice: 100n, slots, pricing: "gsp" });
        const b = runAuction([...cs].reverse(), { floorPrice: 100n, slots, pricing: "gsp" });
        expect(b.winners).toEqual(a.winners);
      }),
      { numRuns: 300 },
    );
  });

  it("PROPERTY: GSP never charges more than first price for the same winner (single-winner campaigns)", () => {
    // The auction is correct, the original property was too broad. Winners of the SAME campaign share
    // one remaining-budget cap, so under GSP an earlier winner pays less and leaves more room, letting a
    // later winner of that campaign pay more than it could under first price (where the cap was already
    // eaten). Price is compared only where no cap is shared; the per-winner bounds (never above own bid,
    // never above remaining budget) are asserted separately for every winner.
    fc.assert(
      fc.property(arbCands, fc.integer({ min: 1, max: 4 }), (cs, slots) => {
        const g = runAuction(cs, { floorPrice: 100n, slots, pricing: "gsp" });
        const f = runAuction(cs, { floorPrice: 100n, slots, pricing: "first_price" });
        for (const w of g.winners) {
          expect(w.price <= w.effectiveBid).toBe(true);
          const c = cs.find((x) => x.campaignId === w.campaignId && x.productId === w.productId);
          if (c !== undefined) expect(w.price <= c.remainingDaily && w.price <= c.balance).toBe(true);
          const shared = g.winners.filter((x) => x.campaignId === w.campaignId).length > 1;
          const fw = f.winners.find((x) => x.productId === w.productId && x.campaignId === w.campaignId);
          const fShared = f.winners.filter((x) => x.campaignId === w.campaignId).length > 1;
          if (fw !== undefined && !shared && !fShared) expect(w.price <= fw.price).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("PROPERTY: winners are unique per product, at most `slots`, and positions are 0..n-1", () => {
    fc.assert(
      fc.property(arbCands, fc.integer({ min: 0, max: 5 }), (cs, slots) => {
        const { winners } = runAuction(cs, { floorPrice: 100n, slots, pricing: "gsp" });
        expect(winners.length).toBeLessThanOrEqual(slots);
        expect(new Set(winners.map((w) => w.productId)).size).toBe(winners.length);
        expect(winners.map((w) => w.position)).toEqual(winners.map((_, i) => i));
      }),
      { numRuns: 300 },
    );
  });
});

describe("campaign state machine and draft validation", () => {
  it("every table row is reachable and every other pair throws", () => {
    const events: CampaignEvent[] = [
      "seller_pause",
      "seller_resume",
      "balance_depleted",
      "balance_restored",
      "enforcement_suspend",
      "enforcement_lifted",
      "end",
    ];
    for (const s of CAMPAIGN_STATUSES) {
      for (const e of events) {
        const to = CAMPAIGN_TRANSITIONS[s][e];
        if (to === undefined) expect(() => transitionCampaign(s, e)).toThrow(InvalidCampaignTransitionError);
        else expect(transitionCampaign(s, e)).toBe(to);
      }
    }
  });

  it("a suspended or unfunded campaign cannot be resumed by the seller", () => {
    expect(() => transitionCampaign("SUSPENDED", "seller_resume")).toThrow();
    expect(() => transitionCampaign("PAUSED_NO_BALANCE", "seller_resume")).toThrow();
  });

  it("ENDED is terminal", () => {
    for (const e of ["seller_pause", "seller_resume", "balance_restored", "enforcement_lifted", "end"] as const) {
      expect(() => transitionCampaign("ENDED", e)).toThrow();
    }
  });

  const draft = {
    name: "Summer dresses",
    dailyBudget: 50_000n,
    maxCpc: 800n,
    keywords: [" Dress ", "dress", "فستان"],
    categories: ["cat-dresses"],
    startsAtMs: 1_000,
    endsAtMs: null,
    bids: [{ productId: "p1", bid: 500n }],
  };
  it("normalizes and de-duplicates keywords", () => {
    const v = validateCampaignDraft(draft, cfg, 2_000);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.value.keywords).toEqual(["dress", "فستان"]);
  });
  it("refuses bids under the floor, max CPC over the daily budget and an empty bid list", () => {
    const v = validateCampaignDraft({ ...draft, maxCpc: 60_000n, bids: [{ productId: "p1", bid: 5n }] }, cfg, 0);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.map((e) => e.code).sort()).toEqual(["above_daily_budget", "below_floor"]);
    const e = validateCampaignDraft({ ...draft, bids: [] }, cfg, 0);
    expect(e.ok).toBe(false);
  });
});

describe("targeting uses only query, category, store scope and locale", () => {
  const c = { storeId: "s1", keywords: ["dress"], categories: ["cat-a"] };
  const ctx = { query: "white linen DRESS", categoryIds: [], storeScope: null, locale: "en" as const };
  it("matches keywords inside the query", () => expect(matchesTargeting(c, [], ctx)).toBe(true));
  it("matches category overlap", () => {
    expect(matchesTargeting(c, ["cat-a"], { ...ctx, query: "shoes" })).toBe(true);
    expect(matchesTargeting(c, [], { ...ctx, query: "shoes" })).toBe(false);
  });
  it("an untargeted campaign matches any query", () => {
    expect(matchesTargeting({ storeId: "s1", keywords: [], categories: [] }, [], { ...ctx, query: "x" })).toBe(true);
  });
  it("My Stores scope excludes stores outside it", () => {
    expect(matchesTargeting(c, [], { ...ctx, storeScope: ["s2"] })).toBe(false);
    expect(matchesTargeting(c, [], { ...ctx, storeScope: ["s1"] })).toBe(true);
  });
  it("the targeting context type carries no budget or measurement field", () => {
    const keys = Object.keys({ query: null, categoryIds: [], storeScope: null, locale: "ar" } satisfies Record<string, unknown>);
    expect(keys.some((k) => /budget|afford|measure|size|payday|install/i.test(k))).toBe(false);
  });
});

describe("invalid traffic filter", () => {
  const ok: ClickSignals = {
    nowMs: 100_000,
    tokenIssuedAtMs: 90_000,
    impressionAtMs: 90_000,
    validInWindow: 0,
    clicksLastMinute: 0,
    campaignClicksToday: 0,
    selfClick: false,
    botScoreBp: 0,
  };
  it("accepts an ordinary click", () => expect(classifyClick(ok, cfg)).toEqual({ valid: true }));
  it.each([
    [{ nowMs: 90_000 + cfg.clickTokenTtlMs + 1 }, "token_expired"],
    [{ selfClick: true }, "self_click"],
    [{ botScoreBp: 9_000 }, "bot"],
    [{ nowMs: 90_100 }, "too_fast"],
    [{ clicksLastMinute: 5 }, "burst"],
    [{ validInWindow: 1 }, "duplicate_window"],
    [{ campaignClicksToday: 3 }, "campaign_drain"],
  ] as const)("flags %j as %s", (over, reason) => {
    expect(classifyClick({ ...ok, ...over }, cfg)).toEqual({ valid: false, reason });
  });
  it("a missing bot signal does not block", () => expect(classifyClick({ ...ok, botScoreBp: null }, cfg).valid).toBe(true));
});

describe("billing", () => {
  it("VAT 14% on a top-up and a balanced entry", () => {
    const q = quoteTopUp(100_000n, 1_400n);
    expect(q).toEqual({ net: 100_000n, vat: 14_000n, gross: 114_000n });
    const sums = sumByCurrency(topUpPostings("store1", q, "psp_a"));
    expect([...sums.values()]).toEqual([0n]);
  });
  it("PROPERTY: top-up entries always balance and gross = net + vat", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 1_000_000_000n }), (net) => {
        const q = quoteTopUp(net, 1_400n);
        expect(q.gross).toBe(q.net + q.vat);
        expect([...sumByCurrency(topUpPostings("s", q, "p")).values()]).toEqual([0n]);
      }),
    );
  });
  it("click revenue and its credit-back cancel exactly", () => {
    const a = clickPostings("s", 345n);
    const b = creditBackPostings("s", 345n);
    expect([...sumByCurrency(a).values()]).toEqual([0n]);
    const net = new Map<string, bigint>();
    for (const p of [...a, ...b]) net.set(p.account, (net.get(p.account) ?? 0n) + p.amount.amount);
    expect([...net.values()].every((v) => v === 0n)).toBe(true);
  });
  it("refuses a non-positive click cost", () => expect(() => clickPostings("s", 0n)).toThrow());
});

describe("reports and Cairo day", () => {
  it("CTR, CPC and ROAS are integer and null-safe", () => {
    const v = viewStats({ impressions: 1_000, clicks: 25, spend: 10_000n, attributedRevenue: 45_000n });
    expect(v.ctrBp).toBe(250);
    expect(v.cpc).toBe(400n);
    expect(v.roasBp).toBe(45_000n);
    const z = viewStats({ impressions: 0, clicks: 0, spend: 0n, attributedRevenue: 0n });
    expect([z.ctrBp, z.cpc, z.roasBp]).toEqual([null, null, null]);
  });
  it("sums rows", () => {
    expect(
      sumStats([
        { impressions: 1, clicks: 1, spend: 5n, attributedRevenue: 7n },
        { impressions: 2, clicks: 0, spend: 0n, attributedRevenue: 0n },
      ]),
    ).toEqual({ impressions: 3, clicks: 1, spend: 5n, attributedRevenue: 7n });
  });
  it("the day resets at Cairo midnight, not UTC", () => {
    // 2026-01-15 21:59:59Z is 23:59:59 Cairo (UTC+2); one second later is the next Cairo day.
    const before = Date.UTC(2026, 0, 15, 21, 59, 59);
    expect(cairoDayKey(before)).toBe("2026-01-15");
    expect(cairoDayKey(before + 1000)).toBe("2026-01-16");
    expect(startOfCairoDayMs(before + 5000)).toBe(before + 1000);
  });
});
