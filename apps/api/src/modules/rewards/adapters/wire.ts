import type { OddsDisclosureLine, RewardsConfig } from "../domain/bridge";
import type { ChallengeRow, OddsVersion, PlayRow } from "../domain/ports";
import type { OddsPage } from "../application/games";
import type { RewardsView } from "../application/view";
import { iso } from "../application/shared";

const isoOrNull = (ms: number | null): string | null => (ms === null ? null : iso(ms));

export const challengeWire = (c: ChallengeRow) => ({
  id: c.id,
  code: c.code,
  rule: c.rule,
  window_start: iso(c.windowStartMs),
  window_end: iso(c.windowEndMs),
  reward_coins: c.rewardCoins.toString(),
  active: c.active,
});

/** The owner's own view. Coins are integers as strings; the reset instants are real server times. */
export function rewardsWire(v: RewardsView) {
  return {
    coins: v.coins.toString(),
    credit_piastres: v.creditPiastres.toString(),
    piastres_per_coin: v.piastresPerCoin.toString(),
    debt_coins: v.debtCoins.toString(),
    expiring_soon: { coins: v.expiringSoon.coins.toString(), earliest_at: isoOrNull(v.expiringSoon.earliestMs) },
    tier: {
      tier: v.tier.tier,
      net_spend_12m: v.tier.netSpend12m.toString(),
      next: v.tier.next === null ? null : { tier: v.tier.next.tier, remaining_piastres: v.tier.next.remaining.toString() },
      pending_tier: v.tier.pendingTier,
      pending_effective_at: isoOrNull(v.tier.pendingEffectiveAtMs),
    },
    streak: { months: v.streak.months, current_month_done: v.streak.currentMonthDone, resets_at: isoOrNull(v.streak.resetsAtMs) },
    challenges: v.challenges.map(challengeWire),
    games: v.games.map((g) => ({ game: g.game, enabled: g.enabled, plays_left_today: g.playsLeftToday })),
    history: v.history.map((h) => ({ id: h.id, kind: h.kind, coins: h.coins.toString(), at: iso(h.atMs), expires_at: isoOrNull(h.expiresAtMs) })),
  };
}

const lineWire = (l: OddsDisclosureLine) => ({
  id: l.id,
  kind: l.kind,
  coins: l.coins === null ? null : l.coins.toString(),
  voucher_template_id: l.voucherTemplateId,
  probability_ppm: l.ppm,
  probability_percent: l.percent,
});
const versionWire = (v: OddsVersion, lines: readonly OddsDisclosureLine[]) => ({
  odds_version_id: v.id,
  version: v.version,
  published_at: iso(v.publishedAtMs),
  effective_from: iso(v.effectiveFromMs),
  outcomes: lines.map(lineWire),
});

/** Public odds page. Free to play, coins or vouchers only, never cash. */
export const oddsWire = (game: string, p: OddsPage) => ({
  game,
  free_to_play: true,
  current: p.current === null ? null : versionWire(p.current.version, p.current.lines),
  upcoming: p.upcoming.map((u) => versionWire(u.version, u.lines)),
});

/** A play shows the audit fields: after the play the seed is revealed and can be re-derived. */
export const playWire = (p: PlayRow, replay: boolean) => ({
  play_id: p.id,
  game: p.game,
  outcome: { id: p.outcomeId, kind: p.outcomeKind, coins: p.coins === null ? null : p.coins.toString(), voucher_template_id: p.voucherTemplateId },
  reward_ref: p.rewardRef,
  odds_version_id: p.oddsVersionId,
  replay,
  audit: { roll_ppm: p.rollPpm, server_seed: p.serverSeed, server_seed_hash: p.serverSeedHash, day_key: p.dayKey, seq: p.seq },
  played_at: iso(p.createdAtMs),
});

export function configWire(c: RewardsConfig) {
  return {
    version: c.version,
    piastres_per_coin: c.piastresPerCoin.toString(),
    purchase_bps: c.purchaseBps.toString(),
    plus_bonus_bps: c.plusBonusBps.toString(),
    review_base_coins: c.reviewBaseCoins.toString(),
    review_photo_coins: c.reviewPhotoCoins.toString(),
    review_fit_coins: c.reviewFitCoins.toString(),
    profile_completion_coins: c.profileCompletionCoins.toString(),
    fit_feedback_coins: c.fitFeedbackCoins.toString(),
    max_coins_per_event: c.maxCoinsPerEvent.toString(),
    expiry_months: c.expiryMonths,
    expiring_notice_days: c.expiringNoticeDays,
    silver_from: c.silverFrom.toString(),
    gold_from: c.goldFrom.toString(),
    black_from: c.blackFrom.toString(),
    tier_downgrade_notice_days: c.tierDowngradeNoticeDays,
    streak_milestones: c.streakMilestones.map((m) => ({ months: m.months, coins: m.coins.toString() })),
    daily_plays_per_game: c.dailyPlaysPerGame,
    odds_publish_lead_hours: c.oddsPublishLeadHours,
    max_game_coins: c.maxGameCoins.toString(),
  };
}
