import { dataOf, type schemas } from "../../services/api-client";
import { guard, msOrNull, piastres, unsupported, type AdapterContext } from "../../services/wire";
import { TIERS, type GameId, type GameInfo, type OddsRow, type PlayOutcome, type RewardsPort, type RewardsSnapshot, type Tier } from "./model";

const GAME_TO_WIRE: Readonly<Record<GameId, schemas.GamePlay["game"]>> = { spin: "daily_spin", scratch: "scratch_card" };
const GAME_FROM_WIRE: Readonly<Record<schemas.GamePlay["game"], GameId>> = { daily_spin: "spin", scratch_card: "scratch" };

function tierOf(name: string): Tier {
  return TIERS.find((t) => t === name.toLowerCase()) ?? "bronze";
}

/** /v1/me/rewards, /v1/games/{game}/odds|play. Coins conversion has no amount parameter on the wire (gap). */
export class ApiRewardsPort implements RewardsPort {
  constructor(private readonly ctx: AdapterContext) {}

  load(): Promise<RewardsSnapshot> {
    return guard(async () => {
      const r = dataOf(await this.ctx.client.getMyRewards());
      const odds = await Promise.all(r.games.map(async (g) => ({ g, o: dataOf(await this.ctx.client.getGameOdds({ path: { game: g.game } })) })));
      const games: GameInfo[] = odds.flatMap(({ g, o }) => {
        if (o.current === null) return [];
        const rows: OddsRow[] = o.current.outcomes.map((x) => ({
          kind: x.kind, coins: x.coins !== null ? Number(x.coins) : 0, basisPoints: Math.round(x.probability_ppm / 100),
        }));
        return [{
          game: GAME_FROM_WIRE[g.game],
          oddsVersion: o.current.odds_version_id,
          odds: rows,
          available: g.enabled && g.plays_left_today > 0,
          nextAvailableAtMs: null,
        }];
      });
      const coins = Number(r.coins);
      return {
        coinBalance: coins,
        coinValue: piastres(r.credit_piastres),
        expiring: Number(r.expiring_soon.coins) > 0 ? [{ count: Number(r.expiring_soon.coins), expiresAtMs: msOrNull(r.expiring_soon.earliest_at) ?? this.ctx.nowMs() }] : [],
        tier: {
          tier: tierOf(r.tier.tier),
          nextTier: r.tier.next !== null ? tierOf(r.tier.next.tier) : null,
          remainingToNext: r.tier.next !== null ? piastres(r.tier.next.remaining_piastres) : null,
        },
        gamesEnabled: r.games.some((g) => g.enabled),
        games,
      };
    });
  }

  async convert(_coins: number, _idempotencyKey: string): Promise<void> {
    throw unsupported("convertMyCoins takes no coin amount; converting a partial amount is impossible");
  }

  play(game: GameId, _oddsVersion: string, idempotencyKey: string): Promise<PlayOutcome> {
    return guard(async () => {
      const r = dataOf(await this.ctx.client.playRewardsGame({ path: { game: GAME_TO_WIRE[game] } }, { idempotencyKey }));
      const oddsVersion = r.odds_version_id;
      switch (r.outcome.kind) {
        case "coins": return { kind: "coins", coins: Number(r.outcome.coins ?? "0"), oddsVersion };
        case "voucher": return { kind: "voucher", oddsVersion };
        case "nothing": return { kind: "nothing", oddsVersion };
      }
    });
  }
}
