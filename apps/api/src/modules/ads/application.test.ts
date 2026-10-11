import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ACCOUNTS } from "./domain/bridge";
import { DAY, EGP, P_A1, P_B1, STORE_A, STORE_B, U, createRuntime, type Runtime } from "./test/harness";
import type { SponsoredSelection } from "./application/selection";

const ctx = (over: Partial<{ query: string | null; categoryIds: string[]; storeScope: string[] | null }> = {}) => ({
  query: "white dress" as string | null,
  categoryIds: [] as string[],
  storeScope: null as string[] | null,
  locale: "ar" as const,
  ...over,
});

/** Funds the store through the real top-up flow so the ledger postings exist. */
async function fund(rt: Runtime, storeId: string, net: bigint, key = `fund-${Math.random()}`): Promise<void> {
  const r = await rt.topUp.execute({ storeId, net, idempotencyKey: key });
  if (r.kind !== "ok") throw new Error(`top-up failed: ${r.kind}`);
  const c = await rt.confirm.execute({ topUpId: r.topUp.id, intentRef: r.topUp.intentRef ?? "" });
  if (c.kind !== "credited") throw new Error(`confirm failed: ${c.kind}`);
}

async function launch(rt: Runtime, over: Partial<{ storeId: string; productId: string; bid: bigint; daily: bigint; maxCpc: bigint; keywords: string[] }> = {}) {
  rt.flags.enabled = true;
  const r = await rt.create.execute({
    storeId: over.storeId ?? STORE_A,
    name: "Summer dresses",
    dailyBudget: over.daily ?? EGP(100),
    maxCpc: over.maxCpc ?? EGP(5),
    keywords: over.keywords ?? ["dress"],
    categories: [],
    startsAtMs: rt.clock.nowMs() - 1_000,
    endsAtMs: null,
    bids: [{ productId: over.productId ?? P_A1, bid: over.bid ?? EGP(3) }],
  });
  if (r.kind !== "ok") throw new Error(`create failed: ${r.kind}`);
  return r.campaign;
}

const pick = async (rt: Runtime, session = "session-aaaaaaaaaaaaaaaa", c = ctx()): Promise<readonly SponsoredSelection[]> =>
  rt.select.execute({ ctx: c, sessionId: session });

describe("kill switch and eligibility", () => {
  it("serves nothing while the sponsored_products switch is off (default)", async () => {
    const rt = createRuntime();
    await fund(rt, STORE_A, EGP(500));
    await launch(rt);
    rt.flags.enabled = false;
    expect(await pick(rt)).toEqual([]);
  });

  it("does not serve unpurchasable products, other-store products, or suspended advertisers", async () => {
    const rt = createRuntime();
    await fund(rt, STORE_A, EGP(500));
    await launch(rt);
    expect(await pick(rt)).toHaveLength(1);
    rt.eligibility.seed({ productId: P_A1, storeId: STORE_A, purchasable: false });
    expect(await pick(rt)).toEqual([]);
    rt.eligibility.seed({ productId: P_A1, storeId: STORE_A });
    rt.enforcement.blocked.add(STORE_A);
    expect(await pick(rt)).toEqual([]);
  });

  it("refuses to advertise another store's product", async () => {
    const rt = createRuntime();
    const r = await rt.create.execute({
      storeId: STORE_A, name: "Steal", dailyBudget: EGP(100), maxCpc: EGP(5), keywords: [], categories: [],
      startsAtMs: rt.clock.nowMs(), endsAtMs: null, bids: [{ productId: P_B1, bid: EGP(3) }],
    });
    expect(r.kind).toBe("product_not_owned");
  });

  it("a store under enforcement cannot create campaigns; suspension and release flow through", async () => {
    const rt = createRuntime();
    rt.enforcement.blocked.add(STORE_A);
    const blocked = await rt.create.execute({
      storeId: STORE_A, name: "No ads", dailyBudget: EGP(100), maxCpc: EGP(5), keywords: [], categories: [],
      startsAtMs: rt.clock.nowMs(), endsAtMs: null, bids: [{ productId: P_A1, bid: EGP(3) }],
    });
    expect(blocked.kind).toBe("advertising_blocked");
    rt.enforcement.blocked.delete(STORE_A);
    await fund(rt, STORE_A, EGP(500));
    const c = await launch(rt);
    expect(await rt.enforce.execute({ storeId: STORE_A, blocked: true })).toBe(1);
    expect((await rt.store.getCampaign(c.id))?.status).toBe("SUSPENDED");
    expect(await rt.enforce.execute({ storeId: STORE_A, blocked: false })).toBe(1);
    expect((await rt.store.getCampaign(c.id))?.status).toBe("PAUSED");
  });
});

describe("targeting uses only query, category, store scope and locale", () => {
  it("matches by keyword, by category and honours My Stores scope", async () => {
    const rt = createRuntime();
    await fund(rt, STORE_A, EGP(500));
    await launch(rt, { keywords: ["linen"] });
    expect(await pick(rt, undefined, ctx({ query: "white dress" }))).toEqual([]);
    expect(await pick(rt, undefined, ctx({ query: "linen shirt" }))).toHaveLength(1);
    expect(await pick(rt, undefined, ctx({ query: "linen shirt", storeScope: [STORE_B] }))).toEqual([]);
    expect(await pick(rt, undefined, ctx({ query: "linen shirt", storeScope: [STORE_A] }))).toHaveLength(1);
  });

  it("the targeting context type cannot carry budget or affordability data", () => {
    const keys = Object.keys(ctx()).sort();
    expect(keys).toEqual(["categoryIds", "locale", "query", "storeScope"]);
  });
});

describe("auction through the module", () => {
  it("never serves a campaign whose daily budget is exhausted", async () => {
    const rt = createRuntime();
    await fund(rt, STORE_A, EGP(500));
    await launch(rt, { daily: 100n, maxCpc: 100n, bid: 100n });
    const [s] = await pick(rt);
    expect(s).toBeDefined();
    if (s === undefined) return;
    rt.clock.advance(1_000);
    const billed = await rt.click.execute({ token: s.clickToken, sessionId: "session-aaaaaaaaaaaaaaaa", viewerStoreIds: [] });
    expect(billed.kind).toBe("billed");
    expect(await pick(rt, "session-bbbbbbbbbbbbbbbb")).toEqual([]);
  });

  it("applies the per-session frequency cap per Cairo day", async () => {
    const rt = createRuntime();
    await fund(rt, STORE_A, EGP(500));
    await launch(rt);
    let served = 0;
    for (let i = 0; i < 8; i += 1) served += (await pick(rt)).length;
    expect(served).toBe(5);
    rt.clock.advance(DAY);
    expect(await pick(rt)).toHaveLength(1);
  });

  it("best bid wins when two campaigns advertise the same product", async () => {
    const rt = createRuntime();
    await fund(rt, STORE_A, EGP(500));
    const low = await launch(rt, { bid: EGP(2) });
    const high = await launch(rt, { bid: EGP(4) });
    const r = await pick(rt);
    expect(r).toHaveLength(1);
    expect(r[0]?.campaignId).toBe(high.id);
    expect(r[0]?.campaignId).not.toBe(low.id);
  });
});

describe("click billing", () => {
  const first = async (rt: Runtime) => {
    const [s] = await pick(rt);
    if (s === undefined) throw new Error("no selection");
    return s;
  };

  it("bills a valid click once, posts spend to the ledger idempotently and keeps the balance in step", async () => {
    const rt = createRuntime();
    await fund(rt, STORE_A, EGP(500));
    await launch(rt);
    const s = await first(rt);
    rt.clock.advance(1_000);
    const r = await rt.click.execute({ token: s.clickToken, sessionId: "session-aaaaaaaaaaaaaaaa", viewerStoreIds: [] });
    expect(r.kind).toBe("billed");
    const again = await rt.click.execute({ token: s.clickToken, sessionId: "session-aaaaaaaaaaaaaaaa", viewerStoreIds: [] });
    expect(again).toMatchObject({ kind: "not_billed", reason: "duplicate_token" });
    if (r.kind !== "billed") return;
    const spend = rt.ledger.entries.filter((e) => e.kind === "ads_click");
    expect(spend).toHaveLength(1);
    expect(spend[0]?.postings.reduce((a, p) => a + p.amount, 0n)).toBe(0n);
    expect(spend[0]?.postings.map((p) => p.account)).toEqual([ACCOUNTS.prepaidLiability(STORE_A), ACCOUNTS.revenue]);
    expect((await rt.balance.execute(STORE_A)).balance).toBe(EGP(500) - r.cost);
    expect(rt.store.outbox.filter((e) => e.type === "ad.click_valid")).toHaveLength(1);
  });

  it("the winner pays no more than the maximum CPC and no more than its bid", async () => {
    const rt = createRuntime();
    await fund(rt, STORE_A, EGP(500));
    await launch(rt, { bid: EGP(4), maxCpc: EGP(2) });
    const s = await first(rt);
    rt.clock.advance(1_000);
    const r = await rt.click.execute({ token: s.clickToken, sessionId: "session-aaaaaaaaaaaaaaaa", viewerStoreIds: [] });
    expect(r.kind === "billed" && r.cost <= EGP(2)).toBe(true);
  });

  it("rejects forged, foreign-session and tampered tokens", async () => {
    const rt = createRuntime();
    await fund(rt, STORE_A, EGP(500));
    await launch(rt);
    const s = await first(rt);
    rt.clock.advance(1_000);
    expect((await rt.click.execute({ token: "garbage", sessionId: "session-aaaaaaaaaaaaaaaa", viewerStoreIds: [] })).kind).toBe("invalid_token");
    expect((await rt.click.execute({ token: s.clickToken, sessionId: "session-zzzzzzzzzzzzzzzz", viewerStoreIds: [] })).kind).toBe("invalid_token");
    const parts = s.clickToken.split(".");
    parts[2] = "1";
    expect((await rt.click.execute({ token: parts.join("."), sessionId: "session-aaaaaaaaaaaaaaaa", viewerStoreIds: [] })).kind).toBe("invalid_token");
    expect((await rt.balance.execute(STORE_A)).balance).toBe(EGP(500));
  });

  it("filters invalid traffic: too fast, self click, bot, expired token; none are billed", async () => {
    const rt = createRuntime();
    await fund(rt, STORE_A, EGP(500));
    await launch(rt);
    const fast = await first(rt);
    expect(await rt.click.execute({ token: fast.clickToken, sessionId: "session-aaaaaaaaaaaaaaaa", viewerStoreIds: [] })).toMatchObject({ reason: "too_fast" });

    const own = await first(rt);
    rt.clock.advance(1_000);
    expect(await rt.click.execute({ token: own.clickToken, sessionId: "session-aaaaaaaaaaaaaaaa", viewerStoreIds: [STORE_A] })).toMatchObject({ reason: "self_click" });

    const bot = await first(rt);
    rt.clock.advance(1_000);
    const hash = await rt.d.secret.hmac("ad-session:session-aaaaaaaaaaaaaaaa");
    rt.bots.scores.set(hash, 9_500);
    expect(await rt.click.execute({ token: bot.clickToken, sessionId: "session-aaaaaaaaaaaaaaaa", viewerStoreIds: [] })).toMatchObject({ reason: "bot" });
    rt.bots.scores.clear();

    const old = await first(rt);
    rt.clock.advance(31 * 60_000);
    expect(await rt.click.execute({ token: old.clickToken, sessionId: "session-aaaaaaaaaaaaaaaa", viewerStoreIds: [] })).toMatchObject({ reason: "token_expired" });
    expect((await rt.balance.execute(STORE_A)).balance).toBe(EGP(500));
  });

  it("dedupes repeat clicks of one session on the same ad inside the window", async () => {
    const rt = createRuntime();
    await fund(rt, STORE_A, EGP(500));
    await launch(rt);
    const a = await first(rt);
    const b = await first(rt);
    rt.clock.advance(1_000);
    expect((await rt.click.execute({ token: a.clickToken, sessionId: "session-aaaaaaaaaaaaaaaa", viewerStoreIds: [] })).kind).toBe("billed");
    expect(await rt.click.execute({ token: b.clickToken, sessionId: "session-aaaaaaaaaaaaaaaa", viewerStoreIds: [] })).toMatchObject({ reason: "duplicate_window" });
  });

  it("B-8: two simultaneous clicks of one session on two impressions bill once (signals re-read inside billing)", async () => {
    const rt = createRuntime();
    await fund(rt, STORE_A, EGP(500));
    await launch(rt);
    const a = await first(rt);
    const b = await first(rt);
    rt.clock.advance(1_000);
    const outs = await Promise.all([
      rt.click.execute({ token: a.clickToken, sessionId: "session-aaaaaaaaaaaaaaaa", viewerStoreIds: [] }),
      rt.click.execute({ token: b.clickToken, sessionId: "session-aaaaaaaaaaaaaaaa", viewerStoreIds: [] }),
    ]);
    expect(outs.filter((o) => o.kind === "billed")).toHaveLength(1);
  });

  it("clicks are never billed when the kill switch is off, but the shopper still reaches the product", async () => {
    const rt = createRuntime();
    await fund(rt, STORE_A, EGP(500));
    await launch(rt);
    const s = await first(rt);
    rt.clock.advance(1_000);
    rt.flags.enabled = false;
    const r = await rt.click.execute({ token: s.clickToken, sessionId: "session-aaaaaaaaaaaaaaaa", viewerStoreIds: [] });
    expect(r).toMatchObject({ kind: "not_billed", productId: P_A1, reason: "kill_switch" });
  });

  it("pauses campaigns when the balance runs out and resumes them after a top-up", async () => {
    const rt = createRuntime();
    const cfg = await rt.getConfig.execute();
    await rt.store.putConfig({ ...cfg, minTopUp: 100n }, U(21));
    await fund(rt, STORE_A, 100n);
    const c = await launch(rt, { bid: 100n, maxCpc: 100n, daily: 1_000n });
    const s = await first(rt);
    rt.clock.advance(1_000);
    const r = await rt.click.execute({ token: s.clickToken, sessionId: "session-aaaaaaaaaaaaaaaa", viewerStoreIds: [] });
    expect(r.kind).toBe("billed");
    expect((await rt.store.getCampaign(c.id))?.status).toBe("PAUSED_NO_BALANCE");
    expect(await pick(rt, "session-cccccccccccccccc")).toEqual([]);
    await fund(rt, STORE_A, EGP(500));
    expect((await rt.store.getCampaign(c.id))?.status).toBe("ACTIVE");
  });

  it("credits a click back (invalid traffic found later) with a mirror ledger entry, once", async () => {
    const rt = createRuntime();
    await fund(rt, STORE_A, EGP(500));
    await launch(rt);
    const s = await first(rt);
    rt.clock.advance(1_000);
    const r = await rt.click.execute({ token: s.clickToken, sessionId: "session-aaaaaaaaaaaaaaaa", viewerStoreIds: [] });
    if (r.kind !== "billed") throw new Error("not billed");
    expect(await rt.creditBack.execute(r.clickId)).toBe("credited");
    expect(await rt.creditBack.execute(r.clickId)).toBe("replayed");
    expect((await rt.balance.execute(STORE_A)).balance).toBe(EGP(500));
    const back = rt.ledger.entries.filter((e) => e.kind === "ads_click_credit_back");
    expect(back).toHaveLength(1);
    const net = rt.ledger.entries.filter((e) => e.kind !== "ads_topup").flatMap((e) => e.postings).reduce((a, p) => a + p.amount, 0n);
    expect(net).toBe(0n);
  });

  it("the sweeper posts clicks whose ledger call failed, exactly once", async () => {
    const rt = createRuntime();
    await fund(rt, STORE_A, EGP(500));
    await launch(rt);
    const s = await first(rt);
    rt.clock.advance(1_000);
    rt.ledger.failing = true;
    const r = await rt.click.execute({ token: s.clickToken, sessionId: "session-aaaaaaaaaaaaaaaa", viewerStoreIds: [] });
    expect(r.kind).toBe("billed");
    expect(await rt.post.execute()).toEqual({ posted: 0, failed: 1 });
    rt.ledger.failing = false;
    expect(await rt.post.execute()).toEqual({ posted: 1, failed: 0 });
    expect(await rt.post.execute()).toEqual({ posted: 0, failed: 0 });
    expect(rt.ledger.entries.filter((e) => e.kind === "ads_click")).toHaveLength(1);
  });

  it("PROPERTY: spend never exceeds the daily budget or the prepaid balance, ledger always nets to zero", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 100, max: 2_000 }),
        fc.integer({ min: 100, max: 5_000 }),
        fc.integer({ min: 1, max: 8 }),
        async (dailyPiastres, balancePiastres, clicks) => {
          const rt = createRuntime();
          const cfg = await rt.getConfig.execute();
          rt.flags.enabled = true;
          await rt.store.putConfig({ ...cfg, minTopUp: 100n, frequencyCapPerSessionDay: 100, maxClicksPerCampaignPerSessionDay: 100, maxClicksPerSessionPerMinute: 100 }, U(21));
          await fund(rt, STORE_A, BigInt(balancePiastres));
          await launch(rt, { daily: BigInt(dailyPiastres), maxCpc: 100n, bid: 100n });
          let billed = 0n;
          for (let i = 0; i < clicks; i += 1) {
            const sess = `session-${String(i).padStart(16, "0")}`;
            const [s] = await rt.select.execute({ ctx: ctx(), sessionId: sess });
            if (s === undefined) continue;
            rt.clock.advance(1_000);
            const r = await rt.click.execute({ token: s.clickToken, sessionId: sess, viewerStoreIds: [] });
            if (r.kind === "billed") billed += r.cost;
          }
          expect(billed <= BigInt(dailyPiastres)).toBe(true);
          expect(billed <= BigInt(balancePiastres)).toBe(true);
          expect((await rt.balance.execute(STORE_A)).balance).toBe(BigInt(balancePiastres) - billed);
          const sum = rt.ledger.entries.flatMap((e) => e.postings).reduce((a, p) => a + p.amount, 0n);
          expect(sum).toBe(0n);
        },
      ),
      { numRuns: 25 },
    );
  });
});

describe("top-ups", () => {
  it("adds VAT 14% once, posts a balanced entry and credits only the net", async () => {
    const rt = createRuntime();
    const r = await rt.topUp.execute({ storeId: STORE_A, net: EGP(1000), idempotencyKey: "k1" });
    if (r.kind !== "ok") throw new Error("top-up failed");
    expect(r.quote).toEqual({ net: EGP(1000), vat: EGP(140), gross: EGP(1140) });
    expect(rt.charges.intents[0]?.gross).toBe(EGP(1140));
    const c = await rt.confirm.execute({ topUpId: r.topUp.id, intentRef: r.topUp.intentRef ?? "" });
    expect(c).toMatchObject({ kind: "credited", balance: EGP(1000) });
    const replay = await rt.confirm.execute({ topUpId: r.topUp.id, intentRef: r.topUp.intentRef ?? "" });
    expect(replay).toMatchObject({ kind: "replayed", balance: EGP(1000) });
    expect(rt.ledger.entries).toHaveLength(1);
    expect(rt.ledger.entries[0]?.postings.reduce((a, p) => a + p.amount, 0n)).toBe(0n);
    expect((await rt.confirm.execute({ topUpId: r.topUp.id, intentRef: "other" })).kind).toBe("intent_mismatch");
  });

  it("is idempotent per key and refuses out-of-range amounts and a failing PSP", async () => {
    const rt = createRuntime();
    const a = await rt.topUp.execute({ storeId: STORE_A, net: EGP(500), idempotencyKey: "same" });
    const b = await rt.topUp.execute({ storeId: STORE_A, net: EGP(500), idempotencyKey: "same" });
    expect(a.kind === "ok" && b.kind === "ok" && a.topUp.id === b.topUp.id && b.replayed).toBe(true);
    expect((await rt.topUp.execute({ storeId: STORE_A, net: 1n, idempotencyKey: "tiny" })).kind).toBe("invalid_amount");
    rt.charges.failing = true;
    expect((await rt.topUp.execute({ storeId: STORE_A, net: EGP(500), idempotencyKey: "psp" })).kind).toBe("psp_unavailable");
  });
});

describe("campaign lifecycle and reports", () => {
  it("validates drafts, pauses, resumes only with balance, and ends past the end date", async () => {
    const rt = createRuntime();
    const bad = await rt.create.execute({
      storeId: STORE_A, name: "x", dailyBudget: 1n, maxCpc: EGP(5), keywords: [], categories: [],
      startsAtMs: rt.clock.nowMs(), endsAtMs: null, bids: [],
    });
    expect(bad.kind).toBe("invalid");
    const c = await launch(rt);
    expect(c.status).toBe("PAUSED_NO_BALANCE");
    expect((await rt.status.execute({ campaignId: c.id, event: "seller_resume" })).kind).toBe("invalid_transition");
    expect((await rt.status.execute({ campaignId: c.id, event: "seller_pause" })).kind).toBe("ok");
    expect((await rt.status.execute({ campaignId: c.id, event: "seller_resume" })).kind).toBe("no_balance");
    await fund(rt, STORE_A, EGP(500));
    expect((await rt.status.execute({ campaignId: c.id, event: "seller_resume" })).kind).toBe("ok");
    const upd = await rt.update.execute({ campaignId: c.id, name: "Renamed", endsAtMs: rt.clock.nowMs() + 1_000 });
    expect(upd.kind).toBe("ok");
    rt.clock.advance(2_000);
    expect(await rt.end.execute()).toBe(1);
    expect((await rt.store.getCampaign(c.id))?.status).toBe("ENDED");
    expect((await rt.status.execute({ campaignId: c.id, event: "seller_pause" })).kind).toBe("invalid_transition");
  });

  it("reports CTR, CPC and ROAS in integer arithmetic", async () => {
    const rt = createRuntime();
    await fund(rt, STORE_A, EGP(500));
    const c = await launch(rt, { bid: EGP(3) });
    for (let i = 0; i < 4; i += 1) {
      const sess = `session-${String(i).padStart(16, "0")}`;
      const [s] = await rt.select.execute({ ctx: ctx(), sessionId: sess });
      if (s === undefined) throw new Error("no selection");
      if (i < 2) {
        rt.clock.advance(1_000);
        await rt.click.execute({ token: s.clickToken, sessionId: sess, viewerStoreIds: [] });
      }
    }
    rt.attribution.revenue = EGP(60);
    const rep = await rt.reports.execute({ storeId: STORE_A, campaignId: null, fromMs: rt.clock.nowMs() - DAY, toMs: rt.clock.nowMs() + DAY });
    expect(rep.total.impressions).toBe(4);
    expect(rep.total.clicks).toBe(2);
    expect(rep.total.ctrBp).toBe(5_000);
    expect(rep.total.spend).toBeGreaterThan(0n);
    expect(rep.total.cpc).toBe(rep.total.spend / 2n);
    expect(rep.campaigns.map((x) => x.campaignId)).toEqual([c.id]);
    expect(rep.total.roasBp).not.toBeNull();
  });
});
