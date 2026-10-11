import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { sumByCurrency } from "../ledger";
import {
  DEFAULT_REWARDS_CONFIG as CFG,
  InvalidOddsTableError,
  InvalidRewardsConfigError,
  PPM,
  cairoDayKey,
  cairoMonthKey,
  clawbackCoins,
  coinClawbackEntry,
  coinGrantEntry,
  drawMessage,
  evaluateTier,
  expectedMicroCoins,
  expiringSoon,
  milestoneAt,
  netAgainstDebt,
  netSpend12m,
  nextCairoDayStartMs,
  nextTierProgress,
  oddsDisclosure,
  planCoinExpiry,
  purchaseCoins,
  reviewCoins,
  rollFromBlocks,
  selectOutcome,
  streakState,
  tierFor,
  validateOddsTable,
  validateRewardsConfig,
  type OddsTable,
  type RewardsConfig,
  type TierState,
} from "./index";

const NOW = Date.UTC(2026, 9, 11, 10, 0, 0);
const DAY = 86_400_000;
const meta = (k: string) => ({ id: `e-${k}`, idempotencyKey: k, occurredAt: new Date(NOW), ref: { type: "rewards", id: k } });

describe("config", () => {
  it("accepts the default and rejects broken variants", () => {
    expect(validateRewardsConfig(CFG)).toBe(CFG);
    const bad = (o: Partial<RewardsConfig>) => () => validateRewardsConfig({ ...CFG, ...o });
    expect(bad({ piastresPerCoin: 0n })).toThrow(InvalidRewardsConfigError);
    expect(bad({ purchaseBps: 10_001n })).toThrow(InvalidRewardsConfigError);
    expect(bad({ goldFrom: CFG.silverFrom })).toThrow(InvalidRewardsConfigError);
    expect(bad({ expiryMonths: 0 })).toThrow(InvalidRewardsConfigError);
    expect(bad({ dailyPlaysPerGame: 4 })).toThrow(InvalidRewardsConfigError);
    expect(bad({ streakMilestones: [{ months: 3, coins: 1n }, { months: 3, coins: 1n }] })).toThrow(InvalidRewardsConfigError);
    expect(bad({ maxGameCoins: CFG.maxCoinsPerEvent + 1n })).toThrow(InvalidRewardsConfigError);
    expect(bad({ version: 0 })).toThrow(InvalidRewardsConfigError);
  });
});

describe("earn", () => {
  it("purchase coins: 1% of net merchandise at 1 coin = 1 piastre, half-even, Plus +5% multiplier", () => {
    expect(purchaseCoins(CFG, 150_000n, false)).toBe(1_500n);
    expect(purchaseCoins(CFG, 150_000n, true)).toBe(1_575n);
    expect(purchaseCoins(CFG, 50n, false)).toBe(0n); // 0.5 piastre rounds to even (0)
    expect(purchaseCoins(CFG, 150n, false)).toBe(2n); // 1.5 rounds to even (2)
    expect(purchaseCoins({ ...CFG, piastresPerCoin: 2n }, 150_000n, false)).toBe(750n);
  });

  it("caps a single event and never returns negative", () => {
    expect(purchaseCoins({ ...CFG, purchaseBps: 10_000n }, 10n ** 12n, true)).toBe(CFG.maxCoinsPerEvent);
    expect(() => purchaseCoins(CFG, -1n, false)).toThrow();
  });

  it("review coins are a function of photo and fit info only (identical for 1 and 5 stars)", () => {
    expect(reviewCoins(CFG, { hasPhoto: false, hasFitInfo: false })).toBe(2_000n);
    expect(reviewCoins(CFG, { hasPhoto: true, hasFitInfo: false })).toBe(5_000n);
    expect(reviewCoins(CFG, { hasPhoto: true, hasFitInfo: true })).toBe(7_000n);
    expect(reviewCoins.length).toBe(2); // (cfg, intent): no rating parameter can exist
  });

  it("property: coins are monotonic in spend and Plus never earns less", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 9n }), fc.bigInt({ min: 0n, max: 10n ** 6n }), (a, d) => {
        expect(purchaseCoins(CFG, a + d, false)).toBeGreaterThanOrEqual(purchaseCoins(CFG, a, false));
        expect(purchaseCoins(CFG, a, true)).toBeGreaterThanOrEqual(purchaseCoins(CFG, a, false));
      }),
    );
  });
});

describe("debt netting", () => {
  it("pays debt first and posts only the rest", () => {
    expect(netAgainstDebt(300n, 1_000n)).toEqual({ netted: 300n, postable: 700n, remainingDebt: 0n });
    expect(netAgainstDebt(1_500n, 1_000n)).toEqual({ netted: 1_000n, postable: 0n, remainingDebt: 500n });
    expect(netAgainstDebt(0n, 10n)).toEqual({ netted: 0n, postable: 10n, remainingDebt: 0n });
  });
  it("property: conservation", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 6n }), fc.bigInt({ min: 0n, max: 10n ** 6n }), (d, g) => {
        const r = netAgainstDebt(d, g);
        expect(r.netted + r.postable).toBe(g);
        expect(r.netted + r.remainingDebt).toBe(d);
        expect(r.postable).toBeGreaterThanOrEqual(0n);
      }),
    );
  });
});

describe("clawback", () => {
  const base = { earned: 1_000n, alreadyClawed: 0n, orderNetMerchandise: 100_000n };
  it("is proportional for a partial refund", () => {
    expect(clawbackCoins({ ...base, refundedNetMerchandise: 25_000n, cumulativeRefunded: 25_000n })).toBe(250n);
  });
  it("a full refund claws exactly the remainder", () => {
    expect(clawbackCoins({ ...base, alreadyClawed: 250n, refundedNetMerchandise: 75_000n, cumulativeRefunded: 100_000n })).toBe(750n);
  });
  it("never exceeds what is left and nothing when already fully clawed", () => {
    expect(clawbackCoins({ ...base, alreadyClawed: 1_000n, refundedNetMerchandise: 10n, cumulativeRefunded: 10n })).toBe(0n);
    expect(clawbackCoins({ ...base, alreadyClawed: 900n, refundedNetMerchandise: 90_000n, cumulativeRefunded: 90_000n })).toBe(100n);
  });
  it("property: any sequence of partial refunds claws at most what was earned and all of it at full refund", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 100_000n }),
        fc.bigInt({ min: 1_000n, max: 10_000_000n }),
        fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 6 }),
        (earned, net, parts) => {
          let clawed = 0n;
          let refunded = 0n;
          for (const p of parts) {
            const r = (net * BigInt(p)) / 100n / BigInt(parts.length);
            if (r === 0n) continue;
            const take = r + refunded > net ? net - refunded : r;
            refunded += take;
            clawed += clawbackCoins({ earned, alreadyClawed: clawed, orderNetMerchandise: net, refundedNetMerchandise: take, cumulativeRefunded: refunded });
            expect(clawed).toBeLessThanOrEqual(earned);
          }
          const rest = net - refunded;
          clawed += clawbackCoins({ earned, alreadyClawed: clawed, orderNetMerchandise: net, refundedNetMerchandise: rest, cumulativeRefunded: net });
          expect(clawed).toBe(earned);
        },
      ),
    );
  });
});

describe("expiry plan", () => {
  const lots = [
    { id: "a", expiresAtMs: NOW - DAY, remaining: 1_000n },
    { id: "b", expiresAtMs: NOW + 10 * DAY, remaining: 500n },
    { id: "c", expiresAtMs: NOW + 200 * DAY, remaining: 700n },
  ];
  it("expires only the unspent part of due lots, attributing spend to the oldest first", () => {
    // 2200 coins awarded, live balance 1300 => 900 spent, all from lot a => 100 left to expire
    expect(planCoinExpiry(lots, 1_300n, 1n, NOW)).toEqual([{ lotId: "a", coins: 100n }]);
  });
  it("everything spent expires nothing; nothing spent expires the whole due lot", () => {
    expect(planCoinExpiry(lots, 1_200n, 1n, NOW)).toEqual([]);
    expect(planCoinExpiry(lots, 2_200n, 1n, NOW)).toEqual([{ lotId: "a", coins: 1_000n }]);
  });
  it("property: never expires more than the live balance or the lot", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ exp: fc.integer({ min: -400, max: 400 }), rem: fc.bigInt({ min: 1n, max: 5_000n }) }), { maxLength: 8 }),
        fc.bigInt({ min: 0n, max: 40_000n }),
        (ls, balance) => {
          const lots2 = ls.map((l, i) => ({ id: `l${i}`, expiresAtMs: NOW + l.exp * DAY, remaining: l.rem }));
          const steps = planCoinExpiry(lots2, balance, 1n, NOW);
          const total = steps.reduce((a, s) => a + s.coins, 0n);
          expect(total).toBeLessThanOrEqual(balance);
          for (const s of steps) expect(s.coins).toBeLessThanOrEqual(lots2.find((l) => l.id === s.lotId)?.remaining ?? 0n);
        },
      ),
    );
  });
  it("reports only real expiring-soon coins", () => {
    expect(expiringSoon(lots, NOW, 30)).toEqual({ coins: 500n, earliestMs: NOW + 10 * DAY });
    expect(expiringSoon(lots, NOW, 5)).toEqual({ coins: 0n, earliestMs: null });
  });
});

describe("ledger entries", () => {
  it("grant and clawback balance to zero and negate each other", () => {
    const g = coinGrantEntry({ userId: "u1", sub: { kind: "cashback_coins" }, piastres: 1_575n }, meta("g"));
    const c = coinClawbackEntry({ userId: "u1", sub: { kind: "cashback_coins" }, piastres: 1_575n }, meta("c"));
    expect([...sumByCurrency(g.postings).values()]).toEqual([0n]);
    expect([...sumByCurrency(c.postings).values()]).toEqual([0n]);
    const net = new Map<string, bigint>();
    for (const p of [...g.postings, ...c.postings]) net.set(p.account, (net.get(p.account) ?? 0n) + p.amount.amount);
    expect([...net.values()].every((v) => v === 0n)).toBe(true);
    expect(g.postings.some((p) => p.account === "store_credit:u1:cashback_coins" && p.amount.amount < 0n)).toBe(true);
  });
  it("rejects non-positive amounts", () => {
    expect(() => coinGrantEntry({ userId: "u1", sub: { kind: "cashback_coins" }, piastres: 0n }, meta("z"))).toThrow();
    expect(() => coinClawbackEntry({ userId: "u1", sub: { kind: "referral_credit" }, piastres: -1n }, meta("z"))).toThrow();
  });
});

describe("tiers", () => {
  it("maps net spend to tiers at the exact boundaries", () => {
    expect(tierFor(CFG, 0n)).toBe("bronze");
    expect(tierFor(CFG, CFG.silverFrom - 1n)).toBe("bronze");
    expect(tierFor(CFG, CFG.silverFrom)).toBe("silver");
    expect(tierFor(CFG, CFG.goldFrom)).toBe("gold");
    expect(tierFor(CFG, CFG.blackFrom)).toBe("black");
  });
  it("net spend is delivered minus refunds inside the rolling 12 months, floored at zero", () => {
    const pts = [
      { amount: 600_000n, atMs: NOW - 100 * DAY },
      { amount: -100_000n, atMs: NOW - 10 * DAY },
      { amount: 900_000n, atMs: NOW - 400 * DAY },
    ];
    expect(netSpend12m(pts, NOW)).toBe(500_000n);
    expect(netSpend12m([{ amount: -5n, atMs: NOW - DAY }], NOW)).toBe(0n);
  });
  it("upgrades at once, announces a drop with 30 days notice, applies it only after", () => {
    const s0 = { tier: "gold" as const, pendingTier: null, pendingEffectiveAtMs: null };
    const up = evaluateTier(CFG, { ...s0, tier: "bronze" }, CFG.goldFrom, NOW);
    expect(up.change).toEqual({ kind: "upgraded", from: "bronze", to: "gold" });
    const ann = evaluateTier(CFG, s0, 0n, NOW);
    expect(ann.change).toMatchObject({ kind: "downgrade_announced", from: "gold", to: "bronze", effectiveAtMs: NOW + 30 * DAY });
    expect(ann.state.tier).toBe("gold");
    const early = evaluateTier(CFG, ann.state, 0n, NOW + 10 * DAY);
    expect(early.state.tier).toBe("gold");
    expect(early.change.kind).toBe("none");
    const late = evaluateTier(CFG, ann.state, 0n, NOW + 31 * DAY);
    expect(late.change).toEqual({ kind: "downgraded", from: "gold", to: "bronze" });
    expect(late.state).toEqual({ tier: "bronze", pendingTier: null, pendingEffectiveAtMs: null });
  });
  it("cancels an announced drop when spend recovers", () => {
    const ann = evaluateTier(CFG, { tier: "silver", pendingTier: null, pendingEffectiveAtMs: null }, 0n, NOW);
    const back = evaluateTier(CFG, ann.state, CFG.silverFrom, NOW + DAY);
    expect(back.change).toEqual({ kind: "downgrade_cancelled", tier: "silver" });
    expect(back.state.pendingTier).toBeNull();
  });
  it("progress to the next tier", () => {
    expect(nextTierProgress(CFG, 100_000n)).toEqual({ next: "silver", remaining: 400_000n });
    expect(nextTierProgress(CFG, CFG.blackFrom)).toBeNull();
  });
  it("property: evaluation never skips the notice and tier never drops without a prior announcement", () => {
    fc.assert(
      fc.property(fc.array(fc.bigInt({ min: 0n, max: 8_000_000n }), { minLength: 1, maxLength: 12 }), (spends) => {
        let st: TierState = { tier: "black", pendingTier: null, pendingEffectiveAtMs: null };
        let t = NOW;
        for (const sp of spends) {
          const r = evaluateTier(CFG, st, sp, t);
          if (r.change.kind === "downgraded") expect(st.pendingEffectiveAtMs).not.toBeNull();
          st = r.state;
          t += 31 * DAY;
        }
      }),
    );
  });
});

describe("streaks", () => {
  const m = (y: number, mo: number) => `${y}-${String(mo).padStart(2, "0")}`;
  it("counts consecutive Cairo months and shows the real reset instant", () => {
    const set = new Set([m(2026, 8), m(2026, 9), m(2026, 10)]);
    const s = streakState(set, NOW); // Oct 2026 done
    expect(s.length).toBe(3);
    expect(s.startMonthKey).toBe("2026-08");
    expect(s.currentMonthDone).toBe(true);
    expect(cairoMonthKey(s.resetsAtMs as number)).toBe("2026-12");
    const alive = streakState(new Set([m(2026, 8), m(2026, 9)]), NOW);
    expect(alive.length).toBe(2);
    expect(alive.currentMonthDone).toBe(false);
    expect(cairoMonthKey(alive.resetsAtMs as number)).toBe("2026-11");
  });
  it("is lost after a missed month and zero with no orders", () => {
    expect(streakState(new Set([m(2026, 7)]), NOW).length).toBe(0);
    expect(streakState(new Set(), NOW)).toMatchObject({ length: 0, resetsAtMs: null });
  });
  it("milestones come from config", () => {
    expect(milestoneAt(CFG, 3)?.coins).toBe(5_000n);
    expect(milestoneAt(CFG, 4)).toBeNull();
  });
});

describe("cairo calendar", () => {
  it("uses the Cairo day boundary, not UTC", () => {
    const lateUtc = Date.UTC(2026, 0, 10, 22, 30); // 00:30 Jan 11 in Cairo (UTC+2)
    expect(cairoDayKey(lateUtc)).toBe("2026-01-11");
    const next = nextCairoDayStartMs(lateUtc);
    expect(cairoDayKey(next)).toBe("2026-01-12");
    expect(cairoDayKey(next - 60_000)).toBe("2026-01-11");
  });
});

describe("odds tables", () => {
  const T: OddsTable = {
    outcomes: [
      { id: "nothing", kind: "nothing", ppm: 700_000, coins: null, voucherTemplateId: null },
      { id: "c50", kind: "coins", ppm: 250_000, coins: 50n, voucherTemplateId: null },
      { id: "c500", kind: "coins", ppm: 45_000, coins: 500n, voucherTemplateId: null },
      { id: "v10", kind: "voucher", ppm: 5_000, coins: null, voucherTemplateId: "tpl-10" },
    ],
  };
  it("validates a well formed table and rejects each defect", () => {
    expect(validateOddsTable(T, 50_000n)).toBe(T);
    const bad = (outs: OddsTable["outcomes"]) => () => validateOddsTable({ outcomes: outs }, 50_000n);
    expect(bad([{ ...T.outcomes[0]!, ppm: 1 }])).toThrow(InvalidOddsTableError);
    expect(bad([{ id: "x", kind: "cash" as never, ppm: PPM, coins: null, voucherTemplateId: null }])).toThrow(/no cash/);
    expect(bad([{ id: "x", kind: "coins", ppm: PPM, coins: 0n, voucherTemplateId: null }])).toThrow();
    expect(bad([{ id: "x", kind: "coins", ppm: PPM, coins: 60_000n, voucherTemplateId: null }])).toThrow();
    expect(bad([{ id: "x", kind: "voucher", ppm: PPM, coins: null, voucherTemplateId: null }])).toThrow();
    expect(bad([{ id: "x", kind: "nothing", ppm: PPM, coins: 1n, voucherTemplateId: null }])).toThrow();
    expect(bad([])).toThrow();
    expect(bad([T.outcomes[0]!, { ...T.outcomes[0]!, ppm: 300_000 }])).toThrow(/duplicate/);
  });
  it("selects by cumulative ppm at the exact boundaries", () => {
    expect(selectOutcome(T, 0).id).toBe("nothing");
    expect(selectOutcome(T, 699_999).id).toBe("nothing");
    expect(selectOutcome(T, 700_000).id).toBe("c50");
    expect(selectOutcome(T, 995_000).id).toBe("v10");
    expect(selectOutcome(T, 999_999).id).toBe("v10");
    expect(() => selectOutcome(T, PPM)).toThrow();
    expect(() => selectOutcome(T, -1)).toThrow();
  });
  it("discloses exact percentages and expected value", () => {
    expect(oddsDisclosure(T).map((l) => l.percent)).toEqual(["70%", "25%", "4.5%", "0.5%"]);
    expect(expectedMicroCoins(T)).toBe(50n * 250_000n + 500n * 45_000n);
  });
  it("rejection sampling discards biased blocks", () => {
    const high = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    const ok = new Uint8Array([0, 0, 0, 0, 0, 7]);
    expect(rollFromBlocks((i) => (i === 0 ? high : ok))).toBe(7);
    expect(() => rollFromBlocks(() => high)).toThrow();
    expect(() => rollFromBlocks(() => new Uint8Array(3))).toThrow();
  });
  it("draw message is stable and identifies the play", () => {
    expect(drawMessage({ userId: "u", game: "daily_spin", dayKey: "2026-10-11", seq: 1, oddsVersionId: "o1" })).toBe("u|daily_spin|2026-10-11|1|o1");
  });

  it("1,000,000 seeded plays match the published odds within tolerance (chi-square)", () => {
    // splitmix64-like deterministic generator over 32 bit halves, standing in for the CSPRNG interface
    let s = 0x9e3779b9;
    const next32 = (): number => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return (t ^ (t >>> 14)) >>> 0;
    };
    const block = (): Uint8Array => {
      const a = next32();
      const b = next32();
      return new Uint8Array([a >>> 24, (a >>> 16) & 255, (a >>> 8) & 255, a & 255, b >>> 24, (b >>> 16) & 255]);
    };
    const N = 1_000_000;
    const counts = new Map<string, number>();
    for (let i = 0; i < N; i += 1) {
      const o = selectOutcome(T, rollFromBlocks(block));
      counts.set(o.id, (counts.get(o.id) ?? 0) + 1);
    }
    let chi = 0;
    for (const o of T.outcomes) {
      const exp = (N * o.ppm) / PPM;
      const got = counts.get(o.id) ?? 0;
      chi += (got - exp) ** 2 / exp;
      expect(Math.abs(got - exp) / exp).toBeLessThan(0.05);
    }
    // 3 degrees of freedom, p = 0.001 critical value 16.27
    expect(chi).toBeLessThan(16.27);
  });
});
