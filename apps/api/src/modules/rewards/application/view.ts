import {
  expiringSoon,
  netSpend12m,
  nextTierProgress,
  streakState,
  tierFor,
  cairoMonthKey,
  cairoDayKey,
  type Game,
  type Tier,
} from "../domain/bridge";
import type { ChallengeRow } from "../domain/ports";
import { CoinService, lotsOf } from "./coins";
import { currentConfig, type RewardsDeps } from "./shared";

export interface RewardsView {
  readonly coins: bigint;
  readonly creditPiastres: bigint;
  readonly piastresPerCoin: bigint;
  readonly debtCoins: bigint;
  readonly expiringSoon: { readonly coins: bigint; readonly earliestMs: number | null };
  readonly tier: { readonly tier: Tier; readonly netSpend12m: bigint; readonly next: { readonly tier: Tier; readonly remaining: bigint } | null; readonly pendingTier: Tier | null; readonly pendingEffectiveAtMs: number | null };
  readonly streak: { readonly months: number; readonly currentMonthDone: boolean; readonly resetsAtMs: number | null };
  readonly challenges: readonly ChallengeRow[];
  readonly games: readonly { readonly game: Game; readonly enabled: boolean; readonly playsLeftToday: number }[];
  readonly history: readonly { readonly id: string; readonly kind: string; readonly coins: bigint; readonly atMs: number; readonly expiresAtMs: number | null }[];
}

export class GetRewards {
  private readonly coins: CoinService;
  constructor(private readonly d: RewardsDeps) {
    this.coins = new CoinService(d);
  }

  async execute(userId: string): Promise<RewardsView> {
    const cfg = await currentConfig(this.d.store);
    const now = this.d.clock.nowMs();
    await this.coins.settlePending(userId); // never show pending awards as missing
    const events = await this.d.store.coinEventsOf(userId);
    const lots = lotsOf(events).filter((l) => !l.closed && l.expiresAtMs > now);
    const credit = await this.d.credit.cashbackBalance(userId);
    const debt = await this.d.store.debtOf(userId);
    const points = (await this.d.store.spendSince(userId, now - 366 * 86_400_000)).map((s) => ({ amount: s.amount, atMs: s.occurredAtMs }));
    const spend = netSpend12m(points, now);
    const row = await this.d.store.getTier(userId);
    const months = new Set<string>();
    for (const s of await this.d.store.spendSince(userId, now - 14 * 31 * 86_400_000)) {
      if (s.amount > 0n && s.sourceRef.startsWith("order:")) months.add(cairoMonthKey(s.occurredAtMs));
    }
    const st = streakState(months, now);
    const gamesOn = (await this.d.switches.gamesEnabled()) && (await this.d.switches.coinsEnabled());
    const day = cairoDayKey(now);
    const games: { game: Game; enabled: boolean; playsLeftToday: number }[] = [];
    for (const game of ["daily_spin", "scratch_card"] as const) {
      const used = await this.d.store.playsOnDay(userId, game, day);
      games.push({ game, enabled: gamesOn, playsLeftToday: Math.max(0, cfg.dailyPlaysPerGame - used) });
    }
    const next = nextTierProgress(cfg, spend);
    return {
      coins: credit / cfg.piastresPerCoin,
      creditPiastres: credit,
      piastresPerCoin: cfg.piastresPerCoin,
      debtCoins: debt,
      expiringSoon: expiringSoon(lots, now, cfg.expiringNoticeDays),
      tier: {
        tier: row?.tier ?? tierFor(cfg, 0n),
        netSpend12m: spend,
        next: next === null ? null : { tier: next.next, remaining: next.remaining },
        pendingTier: row?.pendingTier ?? null,
        pendingEffectiveAtMs: row?.pendingEffectiveAtMs ?? null,
      },
      streak: { months: st.length, currentMonthDone: st.currentMonthDone, resetsAtMs: st.resetsAtMs },
      challenges: await this.d.store.listChallenges({ activeAtMs: now }),
      games,
      history: events
        .filter((e) => e.amount !== 0n)
        .sort((a, b) => b.createdAtMs - a.createdAtMs)
        .slice(0, 50)
        .map((e) => ({ id: e.id, kind: e.kind, coins: e.amount, atMs: e.createdAtMs, expiresAtMs: e.expiresAtMs })),
    };
  }
}

/** `POST /v1/me/coins/convert`: settles awards recorded while the ledger was unavailable. */
export class ConvertCoins {
  private readonly coins: CoinService;
  constructor(private readonly d: RewardsDeps) {
    this.coins = new CoinService(d);
  }
  async execute(userId: string): Promise<{ readonly settled: number; readonly coins: bigint; readonly creditPiastres: bigint }> {
    const settled = await this.coins.settlePending(userId);
    const cfg = await currentConfig(this.d.store);
    const credit = await this.d.credit.cashbackBalance(userId);
    return { settled, coins: credit / cfg.piastresPerCoin, creditPiastres: credit };
  }
}

/** Nightly: pending settlement, expiry and projection drift. */
export class SweepRewards {
  private readonly coins: CoinService;
  constructor(private readonly d: RewardsDeps) {
    this.coins = new CoinService(d);
  }
  async expiry(limit: number): Promise<{ users: number; coins: bigint }> {
    const users = await this.d.store.usersWithDueLots(this.d.clock.nowMs(), limit);
    let total = 0n;
    for (const u of users) total += await this.coins.expireDue(u);
    return { users: users.length, coins: total };
  }
  settle(limit: number): Promise<number> {
    return this.coins.settlePending(null, limit);
  }
}
