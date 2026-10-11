import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Req } from "@nestjs/common";
import { z } from "zod";
import { Authorize, AuthenticatedSelf, Idempotent, Public, RateLimit } from "../../../platform/decorators";
import { headerValue, type ApiRequest } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import { GAMES } from "../domain/bridge";
import type { GetRewardsConfig, ManageChallenges, UpdateRewardsConfig } from "../application/admin";
import type { GetOdds, PlayGame, PublishOdds } from "../application/games";
import type { ConvertCoins, GetRewards } from "../application/view";
import {
  CONVERT_COINS,
  GET_ODDS,
  GET_REWARDS,
  GET_REWARDS_CONFIG,
  MANAGE_CHALLENGES,
  PLAY_GAME,
  PUBLISH_ODDS,
  REWARDS_ADMIN_RESOLVER,
  UPDATE_REWARDS_CONFIG,
} from "./tokens";
import { challengeWire, configWire, oddsWire, playWire, rewardsWire } from "./wire";

const GameParam = z.object({ game: z.enum(GAMES) }).strict();
const Big = z.string().regex(/^\d{1,15}$/).transform((s) => BigInt(s));

const OddsBody = z
  .object({
    approval_id: z.string().min(1).max(80),
    outcomes: z
      .array(
        z
          .object({
            id: z.string().min(1).max(40),
            kind: z.enum(["nothing", "coins", "voucher"]),
            probability_ppm: z.number().int().min(0).max(1_000_000),
            coins: Big.nullish(),
            voucher_template_id: z.string().min(1).max(80).nullish(),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();

const ConfigBody = z
  .object({
    approval_id: z.string().min(1).max(80),
    piastres_per_coin: Big,
    purchase_bps: Big,
    plus_bonus_bps: Big,
    review_base_coins: Big,
    review_photo_coins: Big,
    review_fit_coins: Big,
    profile_completion_coins: Big,
    fit_feedback_coins: Big,
    max_coins_per_event: Big,
    expiry_months: z.number().int(),
    expiring_notice_days: z.number().int(),
    silver_from: Big,
    gold_from: Big,
    black_from: Big,
    tier_downgrade_notice_days: z.number().int(),
    streak_milestones: z.array(z.object({ months: z.number().int(), coins: Big }).strict()).max(12),
    daily_plays_per_game: z.number().int(),
    odds_publish_lead_hours: z.number().int(),
    max_game_coins: Big,
  })
  .strict();

const ChallengeBody = z
  .object({
    code: z.string().regex(/^[a-z0-9_-]{1,40}$/),
    orders_closed: z.number().int().min(1).max(100),
    window_start: z.iso.datetime(),
    window_end: z.iso.datetime(),
    reward_coins: Big,
  })
  .strict();

const ADMIN_ROLES = ["marketing", "finance", "super_admin"] as const;

const principalOf = (req: ApiRequest) => {
  const p = req.principal;
  if (p === null || p === undefined) throw Problems.unauthenticated();
  return p;
};

const unprocessable = (code: string, title: string): ProblemError => new ProblemError(422, code.replaceAll("_", "-"), title, { code });

@Controller()
export class RewardsController {
  constructor(
    @Inject(GET_REWARDS) private readonly rewards: GetRewards,
    @Inject(CONVERT_COINS) private readonly convert: ConvertCoins,
    @Inject(PLAY_GAME) private readonly play: PlayGame,
    @Inject(GET_ODDS) private readonly odds: GetOdds,
    @Inject(PUBLISH_ODDS) private readonly publish: PublishOdds,
    @Inject(GET_REWARDS_CONFIG) private readonly getConfig: GetRewardsConfig,
    @Inject(UPDATE_REWARDS_CONFIG) private readonly updateConfig: UpdateRewardsConfig,
    @Inject(MANAGE_CHALLENGES) private readonly challenges: ManageChallenges,
  ) {}

  // ---- shopper ----

  @Get("me/rewards")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async mine(@Req() req: ApiRequest) {
    return rewardsWire(await this.rewards.execute(principalOf(req).actor.id));
  }

  @Post("me/coins/convert")
  @HttpCode(200)
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 3600 }])
  async convertCoins(@Req() req: ApiRequest) {
    const r = await this.convert.execute(principalOf(req).actor.id);
    return { settled: r.settled, coins: r.coins.toString(), credit_piastres: r.creditPiastres.toString() };
  }

  @Post("games/:game/play")
  @HttpCode(200)
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 3, windowSeconds: 86_400 }])
  async playGame(@Req() req: ApiRequest, @Param(new ZodPipe(GameParam, "/params")) p: z.infer<typeof GameParam>) {
    const intentId = headerValue(req, "idempotency-key");
    if (intentId === undefined) throw Problems.invalidIdempotencyKey();
    const r = await this.play.execute({
      userId: principalOf(req).actor.id,
      game: p.game,
      intentId,
      attestToken: headerValue(req, "x-app-attest") ?? null,
    });
    switch (r.kind) {
      case "played":
        return playWire(r.play, r.replay);
      case "disabled":
        throw Problems.unavailable("games_disabled");
      case "attestation_failed":
        throw Problems.forbidden("attestation_required");
      case "daily_cap":
        throw unprocessable("daily_limit_reached", "The daily play for this game was already used");
      case "not_eligible":
        throw unprocessable("not_eligible", "No scratch card is available to play");
      case "no_odds":
        throw Problems.unavailable("odds_not_published");
    }
  }

  @Get("games/:game/odds")
  @Public()
  @RateLimit([{ dimension: "ip", limit: 60, windowSeconds: 60 }])
  async publicOdds(@Param(new ZodPipe(GameParam, "/params")) p: z.infer<typeof GameParam>) {
    return oddsWire(p.game, await this.odds.execute(p.game));
  }

  // ---- admin ----

  private requireAdmin(req: ApiRequest): string {
    const actor = principalOf(req).actor;
    const ok = actor.grants.some((g) => g.kind === "admin" && (ADMIN_ROLES as readonly string[]).includes(g.role));
    if (!ok) throw Problems.forbidden();
    return actor.id;
  }

  @Get("admin/rewards/config")
  @Authorize({ audience: "admin_api", action: "read", resourceType: "admin_console", resolver: REWARDS_ADMIN_RESOLVER, idParam: "none" })
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async config(@Req() req: ApiRequest) {
    this.requireAdmin(req);
    return configWire(await this.getConfig.execute());
  }

  @Put("admin/rewards/config")
  @Authorize({ audience: "admin_api", action: "read", resourceType: "admin_console", resolver: REWARDS_ADMIN_RESOLVER, idParam: "none" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 60 }])
  async putConfig(@Req() req: ApiRequest, @Body(new ZodPipe(ConfigBody)) b: z.infer<typeof ConfigBody>) {
    const actorId = this.requireAdmin(req);
    const next = {
      piastresPerCoin: b.piastres_per_coin,
      purchaseBps: b.purchase_bps,
      plusBonusBps: b.plus_bonus_bps,
      reviewBaseCoins: b.review_base_coins,
      reviewPhotoCoins: b.review_photo_coins,
      reviewFitCoins: b.review_fit_coins,
      profileCompletionCoins: b.profile_completion_coins,
      fitFeedbackCoins: b.fit_feedback_coins,
      maxCoinsPerEvent: b.max_coins_per_event,
      expiryMonths: b.expiry_months,
      expiringNoticeDays: b.expiring_notice_days,
      silverFrom: b.silver_from,
      goldFrom: b.gold_from,
      blackFrom: b.black_from,
      tierDowngradeNoticeDays: b.tier_downgrade_notice_days,
      streakMilestones: b.streak_milestones,
      dailyPlaysPerGame: b.daily_plays_per_game,
      oddsPublishLeadHours: b.odds_publish_lead_hours,
      maxGameCoins: b.max_game_coins,
    };
    const r = await this.updateConfig.execute({ actorId, approvalId: b.approval_id, next });
    switch (r.kind) {
      case "ok":
        return configWire(r.config);
      case "invalid":
        throw unprocessable("invalid_config", "The configuration is not valid");
      case "not_approved":
        throw Problems.forbidden("dual_approval_required");
      case "conflict":
        throw new ProblemError(409, "conflict", "The configuration changed, reload and retry", { code: "conflict" });
    }
  }

  @Post("admin/games/:game/odds")
  @HttpCode(201)
  @Authorize({ audience: "admin_api", action: "read", resourceType: "admin_console", resolver: REWARDS_ADMIN_RESOLVER, idParam: "none" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 60 }])
  async publishOdds(
    @Req() req: ApiRequest,
    @Param(new ZodPipe(GameParam, "/params")) p: z.infer<typeof GameParam>,
    @Body(new ZodPipe(OddsBody)) b: z.infer<typeof OddsBody>,
  ) {
    const actorId = this.requireAdmin(req);
    const r = await this.publish.execute({
      actorId,
      approvalId: b.approval_id,
      game: p.game,
      table: {
        outcomes: b.outcomes.map((o) => ({
          id: o.id,
          kind: o.kind,
          ppm: o.probability_ppm,
          coins: o.coins ?? null,
          voucherTemplateId: o.voucher_template_id ?? null,
        })),
      },
    });
    switch (r.kind) {
      case "published":
        return { odds_version_id: r.version.id, version: r.version.version, effective_from: new Date(r.version.effectiveFromMs).toISOString() };
      case "invalid":
        throw unprocessable("invalid_odds", "The odds table is not valid");
      case "not_approved":
        throw Problems.forbidden("dual_approval_required");
      case "conflict":
        throw new ProblemError(409, "conflict", "The odds changed, reload and retry", { code: "conflict" });
    }
  }

  @Get("admin/rewards/challenges")
  @Authorize({ audience: "admin_api", action: "read", resourceType: "admin_console", resolver: REWARDS_ADMIN_RESOLVER, idParam: "none" })
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async listChallenges(@Req() req: ApiRequest) {
    this.requireAdmin(req);
    return { items: (await this.challenges.list()).map(challengeWire) };
  }

  @Post("admin/rewards/challenges")
  @HttpCode(201)
  @Authorize({ audience: "admin_api", action: "read", resourceType: "admin_console", resolver: REWARDS_ADMIN_RESOLVER, idParam: "none" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 60 }])
  async createChallenge(@Req() req: ApiRequest, @Body(new ZodPipe(ChallengeBody)) b: z.infer<typeof ChallengeBody>) {
    this.requireAdmin(req);
    const r = await this.challenges.create({
      code: b.code,
      rule: { kind: "orders_closed", count: b.orders_closed },
      windowStartMs: Date.parse(b.window_start),
      windowEndMs: Date.parse(b.window_end),
      rewardCoins: b.reward_coins,
    });
    switch (r.kind) {
      case "created":
        return challengeWire(r.challenge);
      case "invalid":
        throw unprocessable("invalid_challenge", "The challenge is not valid");
      case "duplicate_code":
        throw new ProblemError(409, "duplicate-code", "A challenge with this code exists", { code: "duplicate_code" });
    }
  }

  @Delete("admin/rewards/challenges/:id")
  @HttpCode(204)
  @Authorize({ audience: "admin_api", action: "read", resourceType: "admin_console", resolver: REWARDS_ADMIN_RESOLVER, idParam: "none" })
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 60 }])
  async deactivate(@Req() req: ApiRequest, @Param(new ZodPipe(z.object({ id: z.uuid() }).strict(), "/params")) p: { id: string }): Promise<void> {
    this.requireAdmin(req);
    if (!(await this.challenges.deactivate(p.id.toLowerCase()))) throw Problems.notFound();
  }
}


