/** Rewards, coins, tiers, light games (spec §15.5, phase2/06). Pure model, ports and fakes. */
import { PortError, type PortFailure } from "../worlds/model";

export { PortError };
export type { PortFailure };

export const TIERS = ["bronze", "silver", "gold", "black"] as const;
export type Tier = (typeof TIERS)[number];
export type GameId = "spin" | "scratch";

export interface ExpiringCoins {
  readonly count: number;
  readonly expiresAtMs: number;
}

export interface TierProgress {
  readonly tier: Tier;
  /** Piastres of net 12-month spend still needed for the next tier; null at the top tier. */
  readonly nextTier: Tier | null;
  readonly remainingToNext: bigint | null;
}

export interface OddsRow {
  readonly kind: "coins" | "voucher" | "nothing";
  readonly coins: number;
  /** Basis points out of 10,000, from the published odds version. */
  readonly basisPoints: number;
}

export interface GameInfo {
  readonly game: GameId;
  readonly oddsVersion: string;
  readonly odds: readonly OddsRow[];
  readonly available: boolean;
  readonly nextAvailableAtMs: number | null;
}

export interface RewardsSnapshot {
  readonly coinBalance: number;
  /** Piastres of store credit one coin converts to (config, versioned). */
  readonly coinValue: bigint;
  readonly expiring: readonly ExpiringCoins[];
  readonly tier: TierProgress;
  /** The `games` kill switch as seen by the server. Default OFF. */
  readonly gamesEnabled: boolean;
  readonly games: readonly GameInfo[];
}

export type PlayOutcome =
  | { readonly kind: "coins"; readonly coins: number; readonly oddsVersion: string }
  | { readonly kind: "voucher"; readonly oddsVersion: string }
  | { readonly kind: "nothing"; readonly oddsVersion: string };

export interface RewardsPort {
  load(): Promise<RewardsSnapshot>;
  convert(coins: number, idempotencyKey: string): Promise<void>;
  play(game: GameId, oddsVersion: string, idempotencyKey: string): Promise<PlayOutcome>;
}

export const BASIS_TOTAL = 10_000;

/** A published odds table must be non-empty and sum to exactly 100%; anything else is not shown or playable. */
export function oddsValid(odds: readonly OddsRow[]): boolean {
  return odds.length > 0 && odds.every((o) => o.basisPoints >= 0) && odds.reduce((s, o) => s + o.basisPoints, 0) === BASIS_TOTAL;
}

/** Basis points as a percent string with at most two decimals, e.g. 250 -> "2.5". */
export function percentText(bp: number): string {
  const whole = Math.floor(bp / 100);
  const frac = bp % 100;
  if (frac === 0) return `${whole}%`;
  const f = String(frac).padStart(2, "0").replace(/0$/, "");
  return `${whole}.${f}%`;
}

export type GameView =
  | { readonly kind: "playable"; readonly info: GameInfo }
  | { readonly kind: "cooldown"; readonly info: GameInfo; readonly nextAtMs: number | null }
  | { readonly kind: "hidden" };

/**
 * Games appear ONLY with the server switch on and a valid published odds table. A playable game
 * always carries the odds the screen must show before the Play button.
 */
export function gameViews(s: RewardsSnapshot): readonly GameView[] {
  if (!s.gamesEnabled) return [];
  return s.games.map((g): GameView => {
    if (!oddsValid(g.odds)) return { kind: "hidden" };
    return g.available ? { kind: "playable", info: g } : { kind: "cooldown", info: g, nextAtMs: g.nextAvailableAtMs };
  }).filter((v) => v.kind !== "hidden");
}

export function sortedExpiring(e: readonly ExpiringCoins[]): readonly ExpiringCoins[] {
  return e.filter((x) => x.count > 0).slice().sort((a, b) => a.expiresAtMs - b.expiresAtMs);
}

export function canConvert(s: RewardsSnapshot): boolean {
  return s.coinBalance > 0 && s.coinValue > 0n;
}

export type RewardsScreenState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly offline: boolean }
  | { readonly status: "ready"; readonly snapshot: RewardsSnapshot };

export function rewardsFailureState(e: unknown): RewardsScreenState {
  return { status: "error", offline: e instanceof PortError && e.kind === "offline" };
}

/* ---- in-memory fakes (development and tests only; synthetic data) ---- */

export const FIXTURE_REWARDS: RewardsSnapshot = {
  coinBalance: 1250,
  coinValue: 1n,
  expiring: [
    { count: 200, expiresAtMs: 1_805_000_000_000 },
    { count: 50, expiresAtMs: 1_803_000_000_000 },
  ],
  tier: { tier: "silver", nextTier: "gold", remainingToNext: 1_500_000n },
  gamesEnabled: false,
  games: [
    {
      game: "spin",
      oddsVersion: "v1",
      available: true,
      nextAvailableAtMs: null,
      odds: [
        { kind: "nothing", coins: 0, basisPoints: 7000 },
        { kind: "coins", coins: 10, basisPoints: 2500 },
        { kind: "voucher", coins: 0, basisPoints: 500 },
      ],
    },
  ],
};

export class InMemoryRewardsPort implements RewardsPort {
  readonly converted: number[] = [];
  readonly plays: string[] = [];
  private snapshot: RewardsSnapshot;
  constructor(initial: RewardsSnapshot = FIXTURE_REWARDS, private failure: PortFailure | null = null, private readonly outcome: PlayOutcome = { kind: "nothing", oddsVersion: "v1" }) {
    this.snapshot = initial;
  }
  setFailure(f: PortFailure | null): void {
    this.failure = f;
  }
  private check(): void {
    if (this.failure !== null) throw new PortError(this.failure);
  }
  async load(): Promise<RewardsSnapshot> {
    this.check();
    return this.snapshot;
  }
  async convert(coins: number): Promise<void> {
    this.check();
    this.converted.push(coins);
    this.snapshot = { ...this.snapshot, coinBalance: this.snapshot.coinBalance - coins };
  }
  async play(game: GameId, oddsVersion: string): Promise<PlayOutcome> {
    this.check();
    this.plays.push(`${game}:${oddsVersion}`);
    return this.outcome;
  }
}
