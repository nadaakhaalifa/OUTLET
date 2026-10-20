import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { chart } from "@outlet/domain";
import { DEFAULT_REWARDS_CONFIG, type OddsTable } from "./domain/bridge";
import { CoinService } from "./application/coins";
import { UpdateRewardsConfig } from "./application/admin";
import { PlayGame, PublishOdds, GetOdds } from "./application/games";
import { TierService } from "./application/tiers";
import { IngestRewardTrigger, type RewardTrigger } from "./application/triggers";
import { ConvertCoins, GetRewards, SweepRewards } from "./application/view";
import { DAY, START_MS, U, makeDeps } from "./test/harness";
import { loadConfig } from "../../config/env";
import { MissingRewardsPortsError, RewardsModule } from "./rewards.module";

const CASHBACK = (u: string): string => chart.storeCredit(u, { kind: "cashback_coins" });
const closed = (orderRef: string, net: bigint, user = U(1)): RewardTrigger => ({
  type: "order.closed",
  userId: user,
  orderRef,
  netMerchandise: net,
  deliveredAtMs: START_MS,
});
const refunded = (orderRef: string, refundRef: string, orderNet: bigint, refundedNet: bigint, cumulative: bigint, user = U(1)): RewardTrigger => ({
  type: "order.refunded",
  userId: user,
  orderRef,
  refundRef,
  orderNetMerchandise: orderNet,
  refundedNetMerchandise: refundedNet,
  cumulativeRefunded: cumulative,
});

const TABLE: OddsTable = {
  outcomes: [
    { id: "nothing", kind: "nothing", ppm: 600_000, coins: null, voucherTemplateId: null },
    { id: "c50", kind: "coins", ppm: 300_000, coins: 50n, voucherTemplateId: null },
    { id: "v10", kind: "voucher", ppm: 100_000, coins: null, voucherTemplateId: "tpl-10" },
  ],
};

async function withOdds(h: ReturnType<typeof makeDeps>, game: "daily_spin" | "scratch_card" = "daily_spin") {
  h.approvals.approve("odds-1", "game_odds", ["a1", "a2"]);
  const r = await new PublishOdds(h.deps).execute({ actorId: "admin-0", approvalId: "odds-1", game, table: TABLE });
  expect(r.kind).toBe("published");
  h.clock.advance(DEFAULT_REWARDS_CONFIG.oddsPublishLeadHours * 3_600_000 + 1);
}

describe("earning", () => {
  it("awards 1% of net merchandise through a balanced ledger entry and is idempotent", async () => {
    const h = makeDeps();
    const ingest = new IngestRewardTrigger(h.deps);
    expect(await ingest.execute(closed("o1", 150_000n))).toEqual({ kind: "applied", coins: 1_500n });
    expect(await ingest.execute(closed("o1", 150_000n))).toEqual({ kind: "duplicate" });
    expect(h.ledger.entries).toHaveLength(1);
    expect(h.ledger.trialBalance()).toBe(0n);
    expect(await h.credit.cashbackBalance(U(1))).toBe(1_500n);
    expect(h.store.events.filter((e) => e.type === "coins.earned")).toHaveLength(1);
  });

  it("Plus members earn 5% more coins", async () => {
    const h = makeDeps();
    h.plus.grant(U(1));
    const r = await new IngestRewardTrigger(h.deps).execute(closed("o1", 150_000n));
    expect(r).toEqual({ kind: "applied", coins: 1_575n });
  });

  it("does nothing while the coins switch is off (kill switch fails closed)", async () => {
    const h = makeDeps();
    h.switches.setCoins(false);
    expect(await new IngestRewardTrigger(h.deps).execute(closed("o1", 150_000n))).toEqual({ kind: "disabled" });
    expect(h.ledger.entries).toHaveLength(0);
    expect(await h.store.coinEventsOf(U(1))).toEqual([]);
  });

  it("review coins depend on photo and fit info only, never on the rating", async () => {
    const h = makeDeps();
    const ingest = new IngestRewardTrigger(h.deps);
    const intent = (reviewId: string, hasPhoto: boolean, hasFitInfo: boolean, user: string): RewardTrigger => ({
      type: "review.reward_intent",
      userId: user,
      reviewId,
      hasPhoto,
      hasFitInfo,
    });
    // the same review content from a 1 star and a 5 star reviewer yields the same coins
    const a = await ingest.execute(intent("r-1star", true, true, U(1)));
    const b = await ingest.execute(intent("r-5star", true, true, U(2)));
    expect(a).toEqual(b);
    expect(a).toEqual({ kind: "applied", coins: 7_000n });
    expect(await ingest.execute(intent("r-plain", false, false, U(1)))).toEqual({ kind: "applied", coins: 2_000n });
    expect(await ingest.execute(intent("r-1star", true, true, U(1)))).toEqual({ kind: "duplicate" });
  });

  it("profile completion and fit feedback pay once", async () => {
    const h = makeDeps();
    const ingest = new IngestRewardTrigger(h.deps);
    expect(await ingest.execute({ type: "profile.completed", userId: U(1), profileId: "p1" })).toEqual({ kind: "applied", coins: 5_000n });
    expect(await ingest.execute({ type: "profile.completed", userId: U(1), profileId: "p2" })).toEqual({ kind: "duplicate" });
    expect(await ingest.execute({ type: "fit.feedback_submitted", userId: U(1), orderLineId: "ol1" })).toEqual({ kind: "applied", coins: 1_000n });
    expect(await ingest.execute({ type: "fit.feedback_submitted", userId: U(1), orderLineId: "ol1" })).toEqual({ kind: "duplicate" });
  });

  it("referral rewards are recorded as referral_credit, not cashback coins", async () => {
    const h = makeDeps();
    const r = await new IngestRewardTrigger(h.deps).execute({
      type: "referral.reward_earned",
      userId: U(1),
      referralId: "ref1",
      amountPiastres: 10_000n,
      idempotencyKey: "referral:ref1:referrer",
    });
    expect(r).toEqual({ kind: "applied", coins: 10_000n });
    expect(h.ledger.balanceOf(chart.storeCredit(U(1), { kind: "referral_credit" }))).toBe(-10_000n);
    expect(h.ledger.balanceOf(CASHBACK(U(1)))).toBe(0n);
  });
});

describe("clawback", () => {
  it("a full refund reverses the grant with a new balanced entry and the balance reconciles", async () => {
    const h = makeDeps();
    const ingest = new IngestRewardTrigger(h.deps);
    await ingest.execute(closed("o1", 150_000n));
    const r = await ingest.execute(refunded("o1", "rf1", 150_000n, 150_000n, 150_000n));
    expect(r).toEqual({ kind: "applied", coins: -1_500n });
    expect(await h.credit.cashbackBalance(U(1))).toBe(0n);
    expect(h.ledger.entries).toHaveLength(2);
    expect(h.ledger.entries[1]?.kind).toBe("coins_clawed_back");
    expect(h.ledger.trialBalance()).toBe(0n);
    expect(await h.store.debtOf(U(1))).toBe(0n);
    expect(h.store.events.some((e) => e.type === "coins.clawed_back")).toBe(true);
  });

  it("a partial refund claws back proportionally; replays post nothing new", async () => {
    const h = makeDeps();
    const ingest = new IngestRewardTrigger(h.deps);
    await ingest.execute(closed("o1", 100_000n)); // 1000 coins
    const t = refunded("o1", "rf1", 100_000n, 25_000n, 25_000n);
    expect(await ingest.execute(t)).toEqual({ kind: "applied", coins: -250n });
    expect(await ingest.execute(t)).toEqual({ kind: "applied", coins: -250n });
    expect(h.ledger.entries).toHaveLength(2);
    expect(await h.credit.cashbackBalance(U(1))).toBe(750n);
    expect(await ingest.execute(refunded("o1", "rf2", 100_000n, 75_000n, 100_000n))).toEqual({ kind: "applied", coins: -750n });
    expect(await h.credit.cashbackBalance(U(1))).toBe(0n);
  });

  it("B-6: two concurrent refunds of one order never claw back more than was earned", async () => {
    const h = makeDeps();
    const ingest = new IngestRewardTrigger(h.deps);
    await ingest.execute(closed("o1", 100_000n)); // 1000 coins
    await Promise.all([
      ingest.execute(refunded("o1", "rf1", 100_000n, 100_000n, 100_000n)),
      ingest.execute(refunded("o1", "rf2", 100_000n, 100_000n, 100_000n)),
    ]);
    expect(await h.credit.cashbackBalance(U(1))).toBe(0n);
    expect(await h.store.debtOf(U(1))).toBe(0n);
    expect(h.ledger.trialBalance()).toBe(0n);
    expect(h.ledger.balanceOf(CASHBACK(U(1)))).toBeLessThanOrEqual(0n);
  });

  it("coins already spent become debt (never charged) and are netted from the next earning", async () => {
    const h = makeDeps();
    const ingest = new IngestRewardTrigger(h.deps);
    await ingest.execute(closed("o1", 100_000n)); // 1000 coins
    await h.credit.spend(U(1), 900n);
    const r = await ingest.execute(refunded("o1", "rf1", 100_000n, 100_000n, 100_000n));
    expect(r).toEqual({ kind: "applied", coins: -1_000n });
    expect(await h.store.debtOf(U(1))).toBe(900n);
    expect(await h.credit.cashbackBalance(U(1))).toBe(0n);
    // next purchase earns 600 coins: all of it pays down debt, nothing is posted
    const before = h.ledger.entries.length;
    expect(await ingest.execute(closed("o2", 60_000n))).toEqual({ kind: "applied", coins: 600n });
    expect(h.ledger.entries.length).toBe(before);
    expect(await h.store.debtOf(U(1))).toBe(300n);
    // a bigger purchase clears the rest and posts only the remainder
    await ingest.execute(closed("o3", 100_000n)); // 1000 coins: 300 to debt, 700 posted
    expect(await h.store.debtOf(U(1))).toBe(0n);
    expect(await h.credit.cashbackBalance(U(1))).toBe(700n);
    expect(h.ledger.trialBalance()).toBe(0n);
  });

  it("a refund for an order without an award is ignored", async () => {
    const h = makeDeps();
    expect(await new IngestRewardTrigger(h.deps).execute(refunded("nope", "rf1", 1_000n, 1_000n, 1_000n))).toEqual({ kind: "ignored" });
  });
});

describe("ledger outage", () => {
  it("records the award as pending, settles once on convert, and never doubles", async () => {
    const h = makeDeps();
    h.ledger.failNext(1);
    const ingest = new IngestRewardTrigger(h.deps);
    expect(await ingest.execute(closed("o1", 100_000n))).toEqual({ kind: "applied", coins: 1_000n });
    expect(h.ledger.entries).toHaveLength(0);
    expect(await h.credit.cashbackBalance(U(1))).toBe(0n);
    const convert = new ConvertCoins(h.deps);
    expect(await convert.execute(U(1))).toEqual({ settled: 1, coins: 1_000n, creditPiastres: 1_000n });
    expect(await convert.execute(U(1))).toEqual({ settled: 0, coins: 1_000n, creditPiastres: 1_000n });
    expect(h.ledger.entries).toHaveLength(1);
    expect(await ingest.execute(closed("o1", 100_000n))).toEqual({ kind: "duplicate" });
  });

  it("a clawback settles a pending award first and then reverses it", async () => {
    const h = makeDeps();
    h.ledger.failNext(1);
    const ingest = new IngestRewardTrigger(h.deps);
    await ingest.execute(closed("o1", 100_000n));
    expect(await ingest.execute(refunded("o1", "rf1", 100_000n, 100_000n, 100_000n))).toEqual({ kind: "applied", coins: -1_000n });
    expect(await h.credit.cashbackBalance(U(1))).toBe(0n);
    expect(h.ledger.entries).toHaveLength(2);
  });

  it("the sweeper settles pending awards for everyone", async () => {
    const h = makeDeps();
    h.ledger.failNext(2);
    const ingest = new IngestRewardTrigger(h.deps);
    await ingest.execute(closed("o1", 100_000n, U(1)));
    await ingest.execute(closed("o2", 100_000n, U(2)));
    expect(await new SweepRewards(h.deps).settle(10)).toBe(2);
    expect(await h.credit.cashbackBalance(U(2))).toBe(1_000n);
  });
});

describe("expiry", () => {
  it("expires only unspent coins after 12 months through the store-credit history, once", async () => {
    const h = makeDeps();
    const ingest = new IngestRewardTrigger(h.deps);
    await ingest.execute(closed("o1", 100_000n)); // 1000 coins at T0
    await h.credit.spend(U(1), 400n);
    h.clock.advance(364 * DAY);
    const sweep = new SweepRewards(h.deps);
    expect(await sweep.expiry(10)).toEqual({ users: 0, coins: 0n });
    h.clock.advance(3 * DAY);
    expect(await sweep.expiry(10)).toEqual({ users: 1, coins: 600n });
    expect(h.credit.expiries).toEqual([{ userId: U(1), piastres: 600n, key: expect.stringContaining("rewards:expire:") }]);
    expect(await h.credit.cashbackBalance(U(1))).toBe(0n);
    expect(await sweep.expiry(10)).toEqual({ users: 0, coins: 0n });
    expect(h.store.events.filter((e) => e.type === "coins.expired")).toHaveLength(1);
    expect(h.ledger.trialBalance()).toBe(0n);
  });

  it("a fully spent lot closes without a write off", async () => {
    const h = makeDeps();
    await new IngestRewardTrigger(h.deps).execute(closed("o1", 100_000n));
    await h.credit.spend(U(1), 1_000n);
    h.clock.advance(400 * DAY);
    expect(await new SweepRewards(h.deps).expiry(10)).toEqual({ users: 1, coins: 0n });
    expect(h.credit.expiries).toEqual([]);
    expect(await new SweepRewards(h.deps).expiry(10)).toEqual({ users: 0, coins: 0n });
  });

  it("the rewards view only warns about coins that really expire inside the notice window", async () => {
    const h = makeDeps();
    await new IngestRewardTrigger(h.deps).execute(closed("o1", 100_000n));
    const view = new GetRewards(h.deps);
    expect((await view.execute(U(1))).expiringSoon.coins).toBe(0n);
    h.clock.advance(340 * DAY);
    const v = await view.execute(U(1));
    expect(v.expiringSoon.coins).toBe(1_000n);
    expect(v.expiringSoon.earliestMs).not.toBeNull();
  });
});

describe("tiers and streaks", () => {
  it("upgrades at once on a closed order and announces a drop with notice", async () => {
    const h = makeDeps();
    const ingest = new IngestRewardTrigger(h.deps);
    await ingest.execute(closed("o1", 600_000n));
    expect((await h.store.getTier(U(1)))?.tier).toBe("silver");
    expect(h.store.events.some((e) => e.type === "tier.changed" && e.change === "upgraded")).toBe(true);
    await ingest.execute(refunded("o1", "rf1", 600_000n, 600_000n, 600_000n));
    // a refund alone never drops the tier on the order path
    expect((await h.store.getTier(U(1)))?.tier).toBe("silver");
    const tiers = new TierService(h.deps);
    await tiers.evaluate(U(1), true);
    const t = await h.store.getTier(U(1));
    expect(t).toMatchObject({ tier: "silver", pendingTier: "bronze" });
    expect(t?.pendingEffectiveAtMs).toBe(h.clock.nowMs() + 30 * DAY);
    h.clock.advance(31 * DAY);
    await tiers.evaluate(U(1), true);
    expect((await h.store.getTier(U(1)))?.tier).toBe("bronze");
  });

  it("the monthly batch evaluates everyone not evaluated since the cut off", async () => {
    const h = makeDeps();
    await new IngestRewardTrigger(h.deps).execute(closed("o1", 10_000n, U(1)));
    await new IngestRewardTrigger(h.deps).execute(closed("o2", 10_000n, U(2)));
    h.clock.advance(35 * DAY);
    expect(await new TierService(h.deps).evaluateBatch(h.clock.nowMs() - 1, 10)).toBe(2);
  });

  it("pays a streak milestone once and shows a real reset time", async () => {
    const h = makeDeps();
    const ingest = new IngestRewardTrigger(h.deps);
    // three consecutive Cairo months
    for (const [i, offset] of [0, 31, 62].entries()) {
      h.clock.set(START_MS + offset * DAY);
      await ingest.execute(closed(`s${i}`, 10_000n));
    }
    const streakEvents = (await h.store.coinEventsOf(U(1))).filter((e) => e.kind === "streak");
    expect(streakEvents).toHaveLength(1);
    expect(streakEvents[0]?.amount).toBe(5_000n);
    const v = await new GetRewards(h.deps).execute(U(1));
    expect(v.streak.months).toBe(3);
    expect(v.streak.resetsAtMs).toBeGreaterThan(h.clock.nowMs());
  });

  it("an order count challenge pays once inside its window", async () => {
    const h = makeDeps();
    h.store.insertChallenge({
      id: "00000000-0000-7000-8000-00000000cc01",
      code: "two-orders",
      rule: { kind: "orders_closed", count: 2 },
      windowStartMs: START_MS - DAY,
      windowEndMs: START_MS + 30 * DAY,
      rewardCoins: 3_000n,
      active: true,
      createdAtMs: START_MS,
    });
    const ingest = new IngestRewardTrigger(h.deps);
    await ingest.execute(closed("c1", 10_000n));
    expect((await h.store.coinEventsOf(U(1))).some((e) => e.kind === "challenge")).toBe(false);
    await ingest.execute(closed("c2", 10_000n));
    await ingest.execute(closed("c3", 10_000n));
    expect((await h.store.coinEventsOf(U(1))).filter((e) => e.kind === "challenge")).toHaveLength(1);
  });
});

describe("games", () => {
  const play = (h: ReturnType<typeof makeDeps>, intent: string, game: "daily_spin" | "scratch_card" = "daily_spin", user = U(1)) =>
    new PlayGame(h.deps).execute({ userId: user, game, intentId: intent, attestToken: `attest-${user}` });

  it("is refused while the kill switch is off", async () => {
    const h = makeDeps();
    h.switches.setGames(false);
    await withOdds(h);
    expect((await play(h, "intent-00000001")).kind).toBe("disabled");
    expect(await h.store.playsOnDay(U(1), "daily_spin", "x")).toBe(0);
  });

  it("requires a valid attestation", async () => {
    const h = makeDeps();
    await withOdds(h);
    const r = await new PlayGame(h.deps).execute({ userId: U(1), game: "daily_spin", intentId: "intent-00000001", attestToken: null });
    expect(r.kind).toBe("attestation_failed");
  });

  it("needs published odds that are already effective", async () => {
    const h = makeDeps();
    expect((await play(h, "intent-00000001")).kind).toBe("no_odds");
    h.approvals.approve("odds-1", "game_odds", ["a1", "a2"]);
    await new PublishOdds(h.deps).execute({ actorId: "admin-0", approvalId: "odds-1", game: "daily_spin", table: TABLE });
    expect((await play(h, "intent-00000001")).kind).toBe("no_odds"); // published, not yet effective
  });

  it("plays once per Cairo day, replays an intent without a second reward, and re-derives from the audit", async () => {
    const h = makeDeps();
    await withOdds(h);
    const r = await play(h, "intent-00000001");
    expect(r.kind).toBe("played");
    if (r.kind !== "played") return;
    expect(r.replay).toBe(false);
    expect(r.play.settledAtMs).not.toBeNull();
    const again = await play(h, "intent-00000001");
    expect(again.kind === "played" && again.replay && again.play.id === r.play.id).toBe(true);
    expect((await play(h, "intent-00000002")).kind).toBe("daily_cap");
    // audit: the stored seed hashes to the stored hash and the roll is re-derivable
    expect(h.deps.hash.sha256Hex(r.play.serverSeed)).toBe(r.play.serverSeedHash);
    const odds = await h.store.oddsById(r.play.oddsVersionId);
    expect(odds?.table.outcomes.some((o) => o.id === r.play.outcomeId)).toBe(true);
    // next Cairo day the allowance returns
    h.clock.advance(DAY);
    expect((await play(h, "intent-00000003")).kind).toBe("played");
  });

  it("a coin outcome is a ledger posted award and a voucher outcome calls the voucher port", async () => {
    const h = makeDeps();
    await withOdds(h);
    let coinsSeen = false;
    let voucherSeen = false;
    for (let i = 0; i < 60 && !(coinsSeen && voucherSeen); i += 1) {
      const user = U(100 + i);
      const r = await play(h, `intent-${String(i).padStart(8, "0")}`, "daily_spin", user);
      if (r.kind !== "played") continue;
      if (r.play.outcomeKind === "coins") {
        coinsSeen = true;
        expect(await h.credit.cashbackBalance(user)).toBe(50n);
        expect(r.play.rewardRef).not.toBeNull();
      }
      if (r.play.outcomeKind === "voucher") {
        voucherSeen = true;
        expect(h.vouchers.granted.some((g) => g.userId === user && g.templateId === "tpl-10")).toBe(true);
      }
    }
    expect(coinsSeen && voucherSeen).toBe(true);
    expect(h.ledger.trialBalance()).toBe(0n);
  });

  it("scratch cards need a delivered order and play once per order", async () => {
    const h = makeDeps();
    await withOdds(h, "scratch_card");
    expect((await play(h, "intent-00000001", "scratch_card")).kind).toBe("not_eligible");
    await new IngestRewardTrigger(h.deps).execute(closed("o1", 10_000n));
    const r = await play(h, "intent-00000001", "scratch_card");
    expect(r.kind).toBe("played");
    h.clock.advance(DAY);
    expect((await play(h, "intent-00000002", "scratch_card")).kind).toBe("not_eligible");
  });

  it("the odds page shows the version the latest play used", async () => {
    const h = makeDeps();
    await withOdds(h);
    const r = await play(h, "intent-00000001");
    const page = await new GetOdds(h.deps).execute("daily_spin");
    expect(r.kind === "played" && page.current?.version.id === r.play.oddsVersionId).toBe(true);
    expect(page.current?.lines.map((l) => l.percent)).toEqual(["60%", "30%", "10%"]);
  });

  it("a new odds version needs dual approval and only takes effect after the publish lead time", async () => {
    const h = makeDeps();
    await withOdds(h);
    const pub = new PublishOdds(h.deps);
    const next: OddsTable = { outcomes: [{ id: "nothing", kind: "nothing", ppm: 1_000_000, coins: null, voucherTemplateId: null }] };
    expect((await pub.execute({ actorId: "admin-0", approvalId: "missing", game: "daily_spin", table: next })).kind).toBe("not_approved");
    h.approvals.approve("self", "game_odds", ["admin-0", "a2"]); // only one approver besides the requester
    expect((await pub.execute({ actorId: "admin-0", approvalId: "self", game: "daily_spin", table: next })).kind).toBe("not_approved");
    h.approvals.approve("odds-2", "game_odds", ["a1", "a2"]);
    const bad = { outcomes: [{ id: "cash", kind: "nothing" as const, ppm: 5, coins: null, voucherTemplateId: null }] };
    expect((await pub.execute({ actorId: "admin-0", approvalId: "odds-2", game: "daily_spin", table: bad })).kind).toBe("invalid");
    const ok = await pub.execute({ actorId: "admin-0", approvalId: "odds-2", game: "daily_spin", table: next });
    expect(ok.kind).toBe("published");
    const page = await new GetOdds(h.deps).execute("daily_spin");
    expect(page.current?.version.version).toBe(1);
    expect(page.upcoming.map((u) => u.version.version)).toEqual([2]);
  });
});

describe("auditable draw with disclosed odds (HMAC over the real hash adapter)", () => {
  it("20,000 draws match the published odds (chi-square, 2 degrees of freedom)", async () => {
    const { NodeHash } = await import("./adapters/fakes");
    const { drawMessage, rollFromBlocks, selectOutcome } = await import("./domain/bridge");
    const hash = new NodeHash();
    const N = 20_000;
    const counts = new Map<string, number>();
    for (let i = 0; i < N; i += 1) {
      const seed = hash.sha256Hex(`seed-${i}`);
      const msg = drawMessage({ userId: U(1), game: "daily_spin", dayKey: "2027-01-01", seq: 1, oddsVersionId: "o" });
      const o = selectOutcome(TABLE, rollFromBlocks((k) => hash.hmacSha256(seed, `${msg}|${k}`)));
      counts.set(o.id, (counts.get(o.id) ?? 0) + 1);
    }
    let chi = 0;
    for (const o of TABLE.outcomes) {
      const exp = (N * o.ppm) / 1_000_000;
      chi += ((counts.get(o.id) ?? 0) - exp) ** 2 / exp;
    }
    expect(chi).toBeLessThan(13.82); // p = 0.001 for 2 degrees of freedom
  });
});

describe("configuration", () => {
  it("is versioned, validated and dual approved", async () => {
    const h = makeDeps();
    const upd = new UpdateRewardsConfig(h.deps);
    const { version: _v, ...base } = DEFAULT_REWARDS_CONFIG;
    expect((await upd.execute({ actorId: "admin-0", approvalId: "none", next: base })).kind).toBe("not_approved");
    h.approvals.approve("cfg-1", "rewards_config", ["a1", "a2"]);
    expect((await upd.execute({ actorId: "admin-0", approvalId: "cfg-1", next: { ...base, purchaseBps: 20_000n } })).kind).toBe("invalid");
    const ok = await upd.execute({ actorId: "admin-0", approvalId: "cfg-1", next: { ...base, purchaseBps: 200n } });
    expect(ok.kind === "ok" && ok.config.version === 2).toBe(true);
    // the new rate applies to the next award
    expect(await new IngestRewardTrigger(h.deps).execute(closed("o1", 100_000n))).toEqual({ kind: "applied", coins: 2_000n });
  });
});

describe("module wiring", () => {
  it("refuses to start outside test mode without the money and attestation ports", () => {
    const cfg = loadConfig({ NODE_ENV: "development" });
    expect(() => RewardsModule.forRoot(cfg, {})).toThrow(MissingRewardsPortsError);
  });
});

describe("property: the ledger and the coin projection always agree", () => {
  type Op =
    | { t: "close"; order: number; net: number }
    | { t: "refund"; order: number; part: number }
    | { t: "spend"; amount: number }
    | { t: "age"; days: number }
    | { t: "outage" };
  const op: fc.Arbitrary<Op> = fc.oneof(
    fc.record({ t: fc.constant("close" as const), order: fc.integer({ min: 0, max: 4 }), net: fc.integer({ min: 100, max: 500_000 }) }),
    fc.record({ t: fc.constant("refund" as const), order: fc.integer({ min: 0, max: 4 }), part: fc.integer({ min: 1, max: 100 }) }),
    fc.record({ t: fc.constant("spend" as const), amount: fc.integer({ min: 1, max: 3_000 }) }),
    fc.record({ t: fc.constant("age" as const), days: fc.integer({ min: 1, max: 200 }) }),
    fc.record({ t: fc.constant("outage" as const) }),
  );

  it("trial balance is zero, balance never negative, debt never negative", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 25 }), async (ops) => {
        const h = makeDeps();
        const ingest = new IngestRewardTrigger(h.deps);
        const coins = new CoinService(h.deps);
        const nets = new Map<number, bigint>();
        const refundedSoFar = new Map<number, bigint>();
        let n = 0;
        for (const o of ops) {
          n += 1;
          if (o.t === "close") {
            if (nets.has(o.order)) continue;
            nets.set(o.order, BigInt(o.net));
            await ingest.execute(closed(`o${o.order}`, BigInt(o.net)));
          } else if (o.t === "refund") {
            const net = nets.get(o.order);
            if (net === undefined) continue;
            const done = refundedSoFar.get(o.order) ?? 0n;
            const left = net - done;
            if (left <= 0n) continue;
            const r = (net * BigInt(o.part)) / 100n;
            const take = r === 0n ? 1n : r > left ? left : r;
            refundedSoFar.set(o.order, done + take);
            const trig = refunded(`o${o.order}`, `rf-${n}`, net, take, done + take);
            try {
              await ingest.execute(trig);
            } catch {
              // an outbox consumer retries a failed delivery; the retry must be safe
              h.ledger.heal();
              await ingest.execute(trig);
              await ingest.execute(trig);
            }
          } else if (o.t === "spend") {
            h.ledger.heal(); // checkout is another module: only rewards posts see the outage
            const bal = await h.credit.cashbackBalance(U(1));
            const amt = BigInt(o.amount) > bal ? bal : BigInt(o.amount);
            if (amt > 0n) await h.credit.spend(U(1), amt);
          } else if (o.t === "age") {
            h.ledger.heal();
            h.clock.advance(o.days * DAY);
            await coins.expireDue(U(1));
          } else {
            h.ledger.failNext(1);
          }
          expect(h.ledger.trialBalance()).toBe(0n);
          expect(await h.credit.cashbackBalance(U(1))).toBeGreaterThanOrEqual(0n);
          expect(await h.store.debtOf(U(1))).toBeGreaterThanOrEqual(0n);
        }
        h.ledger.heal();
        await coins.settlePending(null);
        // every coin posted is accounted for: credit now + spent + expired + clawed back == granted
        const events = await h.store.coinEventsOf(U(1));
        const granted = events.filter((e) => e.amount > 0n).reduce((a, e) => a + (e.amount + e.debtDelta), 0n);
        const clawed = events.filter((e) => e.kind === "clawback").reduce((a, e) => a + (-e.amount - e.debtDelta), 0n);
        const expired = events.filter((e) => e.kind === "expire").reduce((a, e) => a + -e.amount, 0n);
        const bal = await h.credit.cashbackBalance(U(1));
        const spentLedger = h.ledger.entries
          .filter((e) => e.kind === "test_spend")
          .reduce((a, e) => a + (e.postings[0]?.amount.amount ?? 0n), 0n);
        expect(granted - clawed - expired - spentLedger).toBe(bal);
      }),
      { numRuns: 60 },
    );
  });
});

describe("B-7: no copy claims provable fairness", () => {
  it("player-facing strings and the spec only say disclosed odds", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const root = path.resolve(__dirname, "../../../../..");
    for (const f of ["packages/i18n/src/en.ts", "packages/i18n/src/ar.ts", "apps/api/src/modules/rewards/adapters/rewards.controller.ts"]) {
      const text = fs.readFileSync(path.join(root, f), "utf8");
      expect(text, f).not.toMatch(/provabl[ey]/i);
    }
    const spec = fs.readFileSync(path.join(root, "docs/specs/phase2/06-rewards-coins-games.md"), "utf8");
    expect(spec).not.toMatch(/provably fair/i);
  });
});
