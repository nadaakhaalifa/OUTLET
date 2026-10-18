import { Body, Controller, Get, HttpCode, Inject, Post, Req } from "@nestjs/common";
import { moneyToWire } from "@outlet/validation";
import { z } from "zod";
import { AuthenticatedSelf, Idempotent, RateLimit } from "../../../platform/decorators";
import { headerValue, type ApiRequest } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import type { AttributeReferral, GetMyReferral } from "../application/referrals";
import { ATTRIBUTE_REFERRAL, GET_MY_REFERRAL } from "./tokens";

const AttributeSchema = z.object({ code: z.string().min(1).max(32) }).strict();

function userIdOf(req: ApiRequest): string {
  const id = req.principal?.actor.id;
  if (id === undefined) throw Problems.unauthenticated();
  return id;
}

@Controller()
export class ReferralsController {
  constructor(
    @Inject(GET_MY_REFERRAL) private readonly myReferral: GetMyReferral,
    @Inject(ATTRIBUTE_REFERRAL) private readonly attribute: AttributeReferral,
  ) {}

  /** Keyed by the token subject: there is no object id, so no BOLA surface. */
  @Get("me/referral")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async me(@Req() req: ApiRequest) {
    const v = await this.myReferral.execute(userIdOf(req));
    const money = (amount: bigint) => moneyToWire({ amount, currency: "EGP" });
    return {
      code: v.code,
      share_url: v.deepLink,
      friend_offer: { discount: money(v.friendOffer.discount), min_order: money(v.friendOffer.minOrder) },
      referrer_reward: money(v.referrerReward),
      rewarded_this_year: v.rewardedInWindow,
      yearly_cap: v.rewardedInWindow + v.remainingInWindow,
      referrals: v.referrals.map((r) => ({
        status: r.status === "attributed" ? "pending" : r.status,
        created_at: new Date(r.createdAtMs).toISOString(),
      })),
      pending_count: v.pending,
      rewarded_count: v.rewarded,
      milestone: { every: v.milestone.every, progress: v.milestone.progress, plus_months: v.milestone.plusMonths },
      own_offer: v.offer === null ? null : { discount: money(v.offer.discount), min_order: money(v.offer.minOrder) },
    };
  }

  /**
   * Business rejections (self referral, same device, not a new user, under 18, suspended referrer)
   * are recorded and answered like success so this route is not an eligibility oracle.
   */
  @Post("referrals/attribute")
  @HttpCode(200)
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([
    { dimension: "user", limit: 10, windowSeconds: 60 },
    { dimension: "ip", limit: 30, windowSeconds: 60 },
  ])
  async attributeCode(@Req() req: ApiRequest, @Body(new ZodPipe(AttributeSchema)) b: z.infer<typeof AttributeSchema>) {
    const r = await this.attribute.execute(userIdOf(req), b.code, headerValue(req, "x-app-attest") ?? null);
    switch (r.kind) {
      case "accepted":
        return { attributed: true };
      case "unknown_code":
        throw Problems.notFound();
      case "attestation_failed":
        throw new ProblemError(403, "attestation-required", "Device attestation is required", {
          code: "attestation_required",
        });
    }
  }
}
