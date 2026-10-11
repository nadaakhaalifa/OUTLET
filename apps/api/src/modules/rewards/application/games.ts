import {
  cairoDayKey,
  drawMessage,
  oddsDisclosure,
  rollFromBlocks,
  selectOutcome,
  validateOddsTable,
  type Game,
  type OddsDisclosureLine,
  type OddsTable,
} from "../domain/bridge";
import type { OddsVersion, PlayRow } from "../domain/ports";
import { CoinService } from "./coins";
import { currentConfig, type RewardsDeps } from "./shared";

export type PlayResult =
  | { readonly kind: "played"; readonly play: PlayRow; readonly replay: boolean }
  | { readonly kind: "disabled" }
  | { readonly kind: "attestation_failed" }
  | { readonly kind: "daily_cap" }
  | { readonly kind: "not_eligible" }
  | { readonly kind: "no_odds" };

/**
 * Free games. Draw: HMAC-SHA256 keyed by a fresh CSPRNG server seed over the play identity,
 * mapped to ppm by rejection sampling. The seed hash, seed, odds version and roll are stored so
 * any play is re-derivable by an auditor. Outcomes are coins or vouchers only, never cash.
 */
export class PlayGame {
  private readonly coins: CoinService;
  constructor(private readonly d: RewardsDeps) {
    this.coins = new CoinService(d);
  }

  async execute(input: { readonly userId: string; readonly game: Game; readonly intentId: string; readonly attestToken: string | null }): Promise<PlayResult> {
    if (!(await this.d.switches.gamesEnabled())) return { kind: "disabled" };
    if (!(await this.d.switches.coinsEnabled())) return { kind: "disabled" };
    if (!(await this.d.attest.verify({ userId: input.userId, token: input.attestToken }))) return { kind: "attestation_failed" };

    const existing = await this.d.store.playByIntent(input.userId, input.game, input.intentId);
    if (existing !== null) {
      const settled = existing.settledAtMs === null ? await this.settle(existing) : existing;
      return { kind: "played", play: settled, replay: true };
    }

    const cfg = await currentConfig(this.d.store);
    const now = this.d.clock.nowMs();
    const dayKey = cairoDayKey(now); // server time, Cairo boundary: the device clock is never used
    const used = await this.d.store.playsOnDay(input.userId, input.game, dayKey);
    if (used >= cfg.dailyPlaysPerGame) return { kind: "daily_cap" };

    let sourceRef: string | null = null;
    if (input.game === "scratch_card") {
      sourceRef = await this.d.store.unusedEntitlement(input.userId, input.game);
      if (sourceRef === null) return { kind: "not_eligible" };
    }
    const odds = await this.d.store.effectiveOdds(input.game, now);
    if (odds === null) return { kind: "no_odds" };

    const seed = this.d.random.secureHex(32);
    const seq = used + 1;
    const message = drawMessage({ userId: input.userId, game: input.game, dayKey, seq, oddsVersionId: odds.id });
    const roll = rollFromBlocks((i) => this.d.hash.hmacSha256(seed, `${message}|${i}`));
    const outcome = selectOutcome(odds.table, roll);
    const play: PlayRow = {
      id: this.d.ids.uuidV7(),
      userId: input.userId,
      game: input.game,
      intentId: input.intentId,
      dayKey,
      seq,
      oddsVersionId: odds.id,
      rollPpm: roll,
      outcomeId: outcome.id,
      outcomeKind: outcome.kind,
      coins: outcome.coins,
      voucherTemplateId: outcome.voucherTemplateId,
      serverSeed: seed,
      serverSeedHash: this.d.hash.sha256Hex(seed),
      sourceRef,
      rewardRef: null,
      settledAtMs: null,
      createdAtMs: now,
    };
    const ins = await this.d.store.insertPlay(play);
    if (ins === "cap") return { kind: "daily_cap" };
    if (ins === "duplicate") {
      const again = await this.d.store.playByIntent(input.userId, input.game, input.intentId);
      if (again === null) return { kind: "not_eligible" }; // scratch card already used by another play
      return { kind: "played", play: again.settledAtMs === null ? await this.settle(again) : again, replay: true };
    }
    return { kind: "played", play: await this.settle(play), replay: false };
  }

  /** Applies the reward (idempotent) and marks the play settled. Safe to run again after a crash. */
  private async settle(play: PlayRow): Promise<PlayRow> {
    let rewardRef: string | null = null;
    if (play.outcomeKind === "coins" && play.coins !== null) {
      const r = await this.coins.award({ userId: play.userId, kind: "game", coins: play.coins, sourceRef: `play:${play.id}` });
      rewardRef = r.kind === "awarded" || r.kind === "duplicate" ? (r.event.journalEntryId ?? r.event.id) : null;
    } else if (play.outcomeKind === "voucher" && play.voucherTemplateId !== null) {
      const v = await this.d.vouchers.grant({ userId: play.userId, templateId: play.voucherTemplateId, idempotencyKey: `game:${play.id}` });
      rewardRef = v.voucherId;
    }
    const at = this.d.clock.nowMs();
    await this.d.store.settlePlay(play.id, rewardRef, at, [
      { type: "game.played", userId: play.userId, game: play.game, playId: play.id, outcomeKind: play.outcomeKind, coins: play.coins, oddsVersionId: play.oddsVersionId },
    ]);
    return { ...play, rewardRef, settledAtMs: at };
  }
}

export interface OddsPage {
  readonly current: { readonly version: OddsVersion; readonly lines: OddsDisclosureLine[] } | null;
  readonly upcoming: readonly { readonly version: OddsVersion; readonly lines: OddsDisclosureLine[] }[];
}

/** Public odds page: the version in force and any published but not yet effective version. */
export class GetOdds {
  constructor(private readonly d: RewardsDeps) {}
  async execute(game: Game): Promise<OddsPage> {
    const now = this.d.clock.nowMs();
    const cur = await this.d.store.effectiveOdds(game, now);
    const up = await this.d.store.upcomingOdds(game, now);
    return {
      current: cur === null ? null : { version: cur, lines: oddsDisclosure(cur.table) },
      upcoming: up.map((v) => ({ version: v, lines: oddsDisclosure(v.table) })),
    };
  }
}

export type PublishOddsResult =
  | { readonly kind: "published"; readonly version: OddsVersion }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "not_approved" }
  | { readonly kind: "conflict" };

/** Odds changes are versioned, immutable, dual approved and effective only after the lead time. */
export class PublishOdds {
  constructor(private readonly d: RewardsDeps) {}
  async execute(input: { readonly actorId: string; readonly approvalId: string; readonly game: Game; readonly table: OddsTable }): Promise<PublishOddsResult> {
    const cfg = await currentConfig(this.d.store);
    try {
      validateOddsTable(input.table, cfg.maxGameCoins);
    } catch (e) {
      return { kind: "invalid", reason: e instanceof Error ? e.message : "invalid" };
    }
    if (!(await this.d.approvals.isApproved({ approvalId: input.approvalId, kind: "game_odds", requesterId: input.actorId }))) {
      return { kind: "not_approved" };
    }
    const now = this.d.clock.nowMs();
    const last = await this.d.store.latestOddsVersionNumber(input.game);
    const v: OddsVersion = {
      id: this.d.ids.uuidV7(),
      game: input.game,
      version: last + 1,
      table: input.table,
      publishedAtMs: now,
      effectiveFromMs: now + cfg.oddsPublishLeadHours * 3_600_000,
      approvalId: input.approvalId,
    };
    const r = await this.d.store.publishOdds(v, [
      { type: "game.odds_published", game: v.game, oddsVersionId: v.id, version: v.version, effectiveFromMs: v.effectiveFromMs, actorId: input.actorId },
    ]);
    return r === "ok" ? { kind: "published", version: v } : { kind: "conflict" };
  }
}
